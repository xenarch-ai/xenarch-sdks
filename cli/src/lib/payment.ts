/**
 * V2 (post-XEN-179) payment executor.
 *
 * Mirrors `xenarch-sdks/python/xenarch/_payer.py::_pay_xenarch_v2` for the
 * neutral pieces: pick a facilitator via {@link Router}, sign EIP-3009
 * `transferWithAuthorization` for USDC on Base, POST to the facilitator's
 * `/settle` endpoint, fall back on failure. The caller is responsible for
 * replaying the gated URL with the canonical Xenarch headers — see
 * `src/commands/pay.ts`.
 *
 * No splitter, no `Authorization: Bearer <token>` — strict pivot.
 */

import { ethers } from "ethers";
import {
  Router,
  type FacilitatorConfig,
  type PaymentContext,
} from "./router.js";
import {
  USDC_BASE,
  type GateResponse,
  type PaymentRequirements,
  type PaymentResult,
} from "../types.js";

/** USDC on Base — EIP-712 domain for transferWithAuthorization. */
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<
  string,
  ethers.TypedDataField[]
> = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const SETTLE_TIMEOUT_MS = 30_000;
const AUTH_VALIDITY_S = 600;

export interface ExecutePaymentOptions {
  router?: Router;
}

export class NoFacilitatorSettledError extends Error {
  readonly tried: string[];
  constructor(tried: string[]) {
    super(
      `No facilitator settled the payment. Tried: ${tried.join(", ") || "(none eligible)"}`,
    );
    this.name = "NoFacilitatorSettledError";
    this.tried = tried;
  }
}

/**
 * Pick the x402 PaymentRequirements entry the agent will settle against.
 *
 * Mirrors the spirit of `x402_agent._helpers.select_accept`: prefer
 * `scheme="exact"`, prefer the network advertised on the gate envelope,
 * prefer USDC on Base. Falls back to the first compatible entry if no
 * exact match is found.
 */
export function selectAccept(
  accepts: PaymentRequirements[],
  network: string,
): PaymentRequirements | null {
  if (accepts.length === 0) return null;
  // 1. Exact scheme + matching network + USDC contract.
  for (const a of accepts) {
    if (
      a.scheme === "exact" &&
      a.network === network &&
      a.asset.toLowerCase() === USDC_BASE.toLowerCase()
    ) {
      return a;
    }
  }
  // 2. Exact scheme + matching network.
  for (const a of accepts) {
    if (a.scheme === "exact" && a.network === network) return a;
  }
  // 3. Exact scheme on any network.
  for (const a of accepts) {
    if (a.scheme === "exact") return a;
  }
  // 4. Anything.
  return accepts[0];
}

/**
 * Build a Router from the gate's advertised facilitator list.
 *
 * Lazy-building from the publisher's list is the safest default — we won't
 * settle through a URL the publisher didn't endorse. If the caller injects
 * their own Router (with custom weights, a pre-warmed health window, etc.)
 * we use that instead.
 */
function ensureRouter(gate: GateResponse, opts: ExecutePaymentOptions): Router {
  if (opts.router) return opts.router;
  const configs: FacilitatorConfig[] = gate.facilitators.map((f) => ({
    name: f.name,
    url: f.url,
    specVersion: f.spec_version,
  }));
  // `new Router([])` throws — we let that propagate so the caller sees a
  // clean error instead of a silently-empty select().
  return new Router(configs);
}

interface SignedX402Payload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

async function signEip3009(
  signer: ethers.Signer,
  accept: PaymentRequirements,
  amount: bigint,
): Promise<SignedX402Payload> {
  const from = await signer.getAddress();
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTH_VALIDITY_S);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const message = {
    from,
    to: accept.payTo,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await signer.signTypedData(
    USDC_DOMAIN,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    message,
  );

  return {
    x402Version: 1,
    scheme: "exact",
    network: accept.network,
    payload: {
      signature,
      authorization: {
        from,
        to: accept.payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}

interface SettleResponseBody {
  success?: boolean;
  transaction?: string;
  errorReason?: string;
  [k: string]: unknown;
}

async function postSettle(
  facilitatorUrl: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: SettleResponseBody | null }> {
  const url = `${facilitatorUrl.replace(/\/+$/, "")}/settle`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: SettleResponseBody | null = null;
    try {
      parsed = (await res.json()) as SettleResponseBody;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a V2 (post-XEN-179) payment for a Xenarch gate.
 *
 * Steps:
 *   1. Pick a candidate list of facilitators via {@link Router.select}.
 *   2. Pick the x402 `accepts` entry to settle against.
 *   3. Sign EIP-3009 `transferWithAuthorization` for USDC on Base.
 *   4. POST `{facilitator}/settle` with the signed payload until one succeeds.
 *   5. Return `{tx_hash, facilitator, gate_id, amount_usd}`.
 *
 * The retry GET with `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash` is the
 * caller's responsibility — see `src/commands/pay.ts`.
 */
export async function executePayment(
  gate: GateResponse,
  signer: ethers.Signer,
  opts: ExecutePaymentOptions = {},
): Promise<PaymentResult> {
  const router = ensureRouter(gate, opts);

  const ctx: PaymentContext = {
    chain: gate.network,
    asset: gate.asset,
    amountUsd: gate.price_usd,
  };
  const candidates = router.select(
    ctx,
    gate.facilitators.map((f) => f.url),
  );
  if (candidates.length === 0) {
    throw new NoFacilitatorSettledError([]);
  }

  const accept = selectAccept(gate.accepts, gate.network);
  if (accept === null) {
    throw new Error(
      "Gate has no compatible payment scheme in `accepts` (need scheme=exact).",
    );
  }

  const amount = ethers.parseUnits(gate.price_usd, 6);
  const signed = await signEip3009(signer, accept, amount);

  const settleBody = {
    x402Version: 1,
    paymentPayload: signed,
    paymentRequirements: accept,
  };

  const tried: string[] = [];
  for (const facilitator of candidates) {
    tried.push(facilitator.url);
    const t0 = Date.now();
    let result;
    try {
      result = await postSettle(facilitator.url, settleBody, SETTLE_TIMEOUT_MS);
    } catch {
      router.recordFailure(facilitator.url);
      continue;
    }
    if (
      !result.ok ||
      result.body === null ||
      result.body.success !== true ||
      typeof result.body.transaction !== "string" ||
      result.body.transaction.length === 0
    ) {
      router.recordFailure(facilitator.url);
      continue;
    }
    router.recordSuccess(facilitator.url, Date.now() - t0);
    return {
      tx_hash: result.body.transaction,
      facilitator: facilitator.url,
      gate_id: gate.gate_id,
      amount_usd: gate.price_usd,
    };
  }

  throw new NoFacilitatorSettledError(tried);
}

// ---------------------------------------------------------------------------
// V1 vanilla x402 flow (XEN-359) — pay any non-Xenarch x402 gate.
//
// Mirrors the Python SDK `_payer._pay_v1_inline`: sign an EIP-3009 voucher,
// base64-encode it into the `X-PAYMENT` header, and replay the original URL.
// The resource server (or its own facilitator) settles on-chain and returns
// 200 with the content. No Xenarch facilitator, no canonical-header replay.
// ---------------------------------------------------------------------------

const USDC_BASE_LOWER = USDC_BASE.toLowerCase();

export interface V1Selection {
  accept: PaymentRequirements;
  amount: bigint;
  priceUsd: string;
}

/**
 * Pick + validate the x402 `accepts` entry for a vanilla (non-Xenarch) gate.
 * The CLI can only sign USDC-on-Base `exact`-scheme vouchers, so reject
 * anything else with a clear message instead of signing something the wallet
 * cannot honor.
 */
export function pickV1Accept(accepts: PaymentRequirements[]): V1Selection {
  const accept = selectAccept(accepts, "base");
  if (accept === null) {
    throw new Error("x402 gate advertised no payment requirements.");
  }
  if (
    accept.scheme !== "exact" ||
    accept.network !== "base" ||
    accept.asset.toLowerCase() !== USDC_BASE_LOWER
  ) {
    throw new Error(
      `Unsupported x402 payment requirement (scheme=${accept.scheme}, ` +
        `network=${accept.network}, asset=${accept.asset}). The CLI can only ` +
        `pay USDC on Base with the "exact" scheme.`,
    );
  }
  const amount = BigInt(accept.maxAmountRequired);
  if (amount <= 0n) {
    // BigInt("") is 0n (no throw) — reject the degenerate "sign nothing" case.
    throw new Error(
      `x402 gate requested a non-positive amount (${accept.maxAmountRequired}).`,
    );
  }
  return { accept, amount, priceUsd: ethers.formatUnits(amount, 6) };
}

interface XPaymentResponse {
  transaction?: string;
  txHash?: string;
  [k: string]: unknown;
}

/**
 * Settle a vanilla (non-Xenarch) x402 gate via the V1 `X-PAYMENT` flow.
 * Returns the tx hash if the server echoes one in `X-PAYMENT-RESPONSE`
 * (some do not — success is determined by the HTTP 200, not the tx).
 */
export async function executePaymentV1Inline(
  url: string,
  accept: PaymentRequirements,
  amount: bigint,
  signer: ethers.Signer,
): Promise<{
  tx_hash: string | null;
  pay_to: string;
  content: string;
  contentType: string | null;
}> {
  const signed = await signEip3009(signer, accept, amount);
  const header = Buffer.from(JSON.stringify(signed), "utf8").toString("base64");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SETTLE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-PAYMENT": header, "User-Agent": "xenarch-cli" },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable — status alone is enough */
    }
    throw new Error(
      `Vanilla x402 settlement failed: HTTP ${res.status}` +
        (detail ? ` — ${detail}` : ""),
    );
  }

  // The whole point of paying: read the unlocked content. Read it once,
  // before touching headers. Guarded so a body-read hiccup can't turn an
  // already-settled payment into a thrown "failure".
  const contentType = res.headers.get("content-type");
  let content = "";
  try {
    content = await res.text();
  } catch {
    content = "";
  }

  let txHash: string | null = null;
  const respHeader = res.headers.get("x-payment-response");
  if (respHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(respHeader, "base64").toString("utf8"),
      ) as XPaymentResponse;
      txHash = decoded.transaction ?? decoded.txHash ?? null;
    } catch {
      txHash = null;
    }
  }

  return { tx_hash: txHash, pay_to: accept.payTo, content, contentType };
}
