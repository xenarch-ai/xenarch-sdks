/**
 * Facilitator Router — selects an x402 facilitator per payment.
 *
 * TypeScript port of `xenarch-sdks/python/xenarch/router.py`. Implements
 * `Information/design/facilitator-router.md`. The Router picks a ranked
 * fallback list of facilitators for each payment based on a weighted score
 * (fee, gas sponsorship, spec compliance, observed uptime, observed latency,
 * publisher preference). Failed settlements are recorded as passive health
 * signals; a facilitator that exceeds the failure threshold within the
 * rolling window is circuit-broken for the cooldown period.
 *
 * The Router only selects from facilitators it was constructed with (its
 * "registered stack"). A publisher's pay.json may rank a SUBSET of the
 * registered stack; URLs not in the stack are ignored. This keeps the
 * Router from making outbound calls to arbitrary URLs sourced from
 * publisher metadata.
 */

export interface FacilitatorConfig {
  name: string;
  url: string;
  /** spec_version: "v2" preferred, "v1" supported but downscored. */
  specVersion?: string;
  /** Fee in basis points; 0 means free. */
  feeBps?: number;
  /** Whether the facilitator sponsors gas for the on-chain tx. */
  gasSponsored?: boolean;
  /** Set of chain ids the facilitator supports (e.g. "base"). */
  supportedChains?: Set<string>;
  /** Set of asset symbols (e.g. "USDC"). */
  supportedAssets?: Set<string>;
}

export interface PaymentContext {
  /** Default "base". */
  chain?: string;
  /** Default "USDC". */
  asset?: string;
  /** Decimal as string. Informational only — does not filter. */
  amountUsd?: string;
  /** Publisher-imposed max fee in bps. */
  publisherMaxFeeBps?: number;
}

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface RouterOptions {
  weights?: Partial<Record<ScoreAxis, number>>;
  failureThreshold?: number;
  failureWindowS?: number;
  cooldownS?: number;
  /** Override clock for tests; default `() => Date.now() / 1000`. */
  clock?: () => number;
}

type ScoreAxis = "fee" | "gas" | "spec" | "uptime" | "latency" | "preference";

// §6.1 circuit breaker defaults.
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_FAILURE_WINDOW_S = 60;
export const DEFAULT_COOLDOWN_S = 300;

// §5.2 weights — sum to 1.0.
export const DEFAULT_WEIGHTS: Record<ScoreAxis, number> = {
  fee: 0.3,
  gas: 0.25,
  spec: 0.1,
  uptime: 0.15,
  latency: 0.1,
  preference: 0.1,
};

// §9 — default facilitator stack. Coinbase is configurable, never default.
export const DEFAULT_FACILITATOR_STACK: FacilitatorConfig[] = [
  { name: "PayAI", url: "https://facilitator.payai.network" },
  { name: "xpay", url: "https://facilitator.xpay.dev" },
  { name: "Ultravioleta DAO", url: "https://x402.ultravioletadao.xyz" },
  { name: "x402.rs", url: "https://x402.rs" },
];

/** Bounded ring buffer for timestamps + latency samples. */
class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}

  push(v: T): void {
    this.items.push(v);
    if (this.items.length > this.cap) {
      this.items.shift();
    }
  }

  toArray(): T[] {
    return this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }
}

interface ResolvedConfig {
  name: string;
  url: string;
  specVersion: string;
  feeBps: number;
  gasSponsored: boolean;
  supportedChains: Set<string>;
  supportedAssets: Set<string>;
}

function resolve(c: FacilitatorConfig): ResolvedConfig {
  return {
    name: c.name,
    url: c.url,
    specVersion: c.specVersion ?? "v2",
    feeBps: c.feeBps ?? 0,
    gasSponsored: c.gasSponsored ?? true,
    supportedChains: c.supportedChains ?? new Set(["base"]),
    supportedAssets: c.supportedAssets ?? new Set(["USDC"]),
  };
}

interface FacilitatorState {
  config: ResolvedConfig;
  failures: RingBuffer<number>;
  successes: RingBuffer<number>;
  latencyMs: RingBuffer<number>;
  cooldownUntil: number;
}

function defaultClock(): number {
  return Date.now() / 1000;
}

export class Router {
  private readonly states: Map<string, FacilitatorState>;
  private readonly weights: Record<ScoreAxis, number>;
  private readonly failureThreshold: number;
  private readonly failureWindowS: number;
  private readonly cooldownS: number;
  private readonly clock: () => number;
  private lastUsedUrl: string | null = null;

  constructor(facilitators?: FacilitatorConfig[], opts: RouterOptions = {}) {
    const configs =
      facilitators !== undefined
        ? facilitators.slice()
        : DEFAULT_FACILITATOR_STACK.slice();
    if (configs.length === 0) {
      throw new Error("Router requires at least one facilitator");
    }
    // Map preserves insertion order in JS.
    this.states = new Map();
    for (const c of configs) {
      const resolved = resolve(c);
      this.states.set(resolved.url, {
        config: resolved,
        failures: new RingBuffer<number>(200),
        successes: new RingBuffer<number>(200),
        latencyMs: new RingBuffer<number>(50),
        cooldownUntil: 0,
      });
    }
    this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.failureWindowS = opts.failureWindowS ?? DEFAULT_FAILURE_WINDOW_S;
    this.cooldownS = opts.cooldownS ?? DEFAULT_COOLDOWN_S;
    this.clock = opts.clock ?? defaultClock;
  }

  /** Snapshot of registered configs (mutating the result is harmless). */
  get registered(): FacilitatorConfig[] {
    return Array.from(this.states.values()).map((s) => ({
      name: s.config.name,
      url: s.config.url,
      specVersion: s.config.specVersion,
      feeBps: s.config.feeBps,
      gasSponsored: s.config.gasSponsored,
      supportedChains: new Set(s.config.supportedChains),
      supportedAssets: new Set(s.config.supportedAssets),
    }));
  }

  /** Return a ranked fallback list. Empty list if nothing eligible. */
  select(
    ctx: PaymentContext = {},
    publisherFacilitators?: string[],
    maxResults: number = 3,
  ): FacilitatorConfig[] {
    const chain = ctx.chain ?? "base";
    const asset = ctx.asset ?? "USDC";
    const now = this.clock();

    const candidates: FacilitatorState[] = [];
    for (const state of this.states.values()) {
      const cfg = state.config;
      if (!cfg.supportedChains.has(chain)) continue;
      if (!cfg.supportedAssets.has(asset)) continue;
      if (
        ctx.publisherMaxFeeBps !== undefined &&
        cfg.feeBps > ctx.publisherMaxFeeBps
      )
        continue;
      if (this.healthState(state, now) === "unhealthy") continue;
      candidates.push(state);
    }

    if (candidates.length === 0) return [];

    const publisherRank = new Map<string, number>();
    if (publisherFacilitators && publisherFacilitators.length > 0) {
      let i = 0;
      for (const url of publisherFacilitators) {
        if (this.states.has(url) && !publisherRank.has(url)) {
          publisherRank.set(url, i);
          i += 1;
        }
      }
    }

    const scored = candidates.map((s) => ({
      score: this.score(s, now, publisherRank),
      state: s,
    }));
    scored.sort((a, b) => b.score - a.score);

    // §5.4 tie-break: within 1%, prefer different from last used.
    if (scored.length >= 2 && this.lastUsedUrl) {
      const top = scored[0];
      const next = scored[1];
      const denom = Math.max(Math.abs(top.score), 1e-9);
      if (
        Math.abs(top.score - next.score) / denom < 0.01 &&
        top.state.config.url === this.lastUsedUrl
      ) {
        scored[0] = next;
        scored[1] = top;
      }
    }

    return scored.slice(0, maxResults).map((p) => ({
      name: p.state.config.name,
      url: p.state.config.url,
      specVersion: p.state.config.specVersion,
      feeBps: p.state.config.feeBps,
      gasSponsored: p.state.config.gasSponsored,
      supportedChains: new Set(p.state.config.supportedChains),
      supportedAssets: new Set(p.state.config.supportedAssets),
    }));
  }

  recordSuccess(url: string, latencyMs?: number): void {
    const state = this.states.get(url);
    if (state === undefined) return;
    const now = this.clock();
    state.successes.push(now);
    if (latencyMs !== undefined) state.latencyMs.push(latencyMs);
    this.lastUsedUrl = url;
  }

  recordFailure(url: string): void {
    const state = this.states.get(url);
    if (state === undefined) return;
    const now = this.clock();
    state.failures.push(now);
    let recent = 0;
    for (const t of state.failures.toArray()) {
      if (now - t < this.failureWindowS) recent += 1;
    }
    if (recent >= this.failureThreshold) {
      state.cooldownUntil = now + this.cooldownS;
    }
  }

  health(url: string): HealthState | null {
    const state = this.states.get(url);
    if (state === undefined) return null;
    return this.healthState(state, this.clock());
  }

  private healthState(state: FacilitatorState, now: number): HealthState {
    if (now < state.cooldownUntil) return "unhealthy";
    let recent = 0;
    for (const t of state.failures.toArray()) {
      if (now - t < this.failureWindowS) recent += 1;
    }
    if (recent >= this.failureThreshold) return "unhealthy";
    if (recent > 0) return "degraded";
    return "healthy";
  }

  private score(
    state: FacilitatorState,
    now: number,
    publisherRank: Map<string, number>,
  ): number {
    const cfg = state.config;
    const w = this.weights;
    const fee = 1.0 - Math.min(cfg.feeBps / 100.0, 1.0);
    const gas = cfg.gasSponsored ? 1.0 : 0.0;
    const spec = cfg.specVersion === "v2" ? 1.0 : 0.5;
    const uptime = this.uptimeComponent(state, now);
    const latency = this.latencyComponent(state);
    let preference = 0.0;
    if (publisherRank.size > 0 && publisherRank.has(cfg.url)) {
      const rank = publisherRank.get(cfg.url)!;
      const n = Math.max(publisherRank.size, 1);
      preference = 1.0 - rank / n;
    }
    return (
      w.fee * fee +
      w.gas * gas +
      w.spec * spec +
      w.uptime * uptime +
      w.latency * latency +
      w.preference * preference
    );
  }

  private uptimeComponent(state: FacilitatorState, now: number): number {
    // Spec calls for 7-day rolling; ring buffers are bounded at 200 events,
    // which is approximate but cheap. Untested = optimistic.
    const windowS = 7 * 24 * 3600;
    let s = 0;
    for (const t of state.successes.toArray()) {
      if (now - t < windowS) s += 1;
    }
    let f = 0;
    for (const t of state.failures.toArray()) {
      if (now - t < windowS) f += 1;
    }
    const total = s + f;
    if (total === 0) return 1.0;
    return s / total;
  }

  private latencyComponent(state: FacilitatorState): number {
    const samples = state.latencyMs.toArray();
    if (samples.length === 0) return 1.0;
    // p95 inverted, clamped to [500ms, 5000ms].
    const sorted = samples.slice().sort((a, b) => a - b);
    const p95Idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
    const p95 = sorted[p95Idx];
    if (p95 <= 500) return 1.0;
    if (p95 >= 5000) return 0.0;
    return 1.0 - (p95 - 500) / 4500;
  }
}
