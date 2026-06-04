import {
  fetchGate,
  payAndFetch,
  getLinkSchema,
  validateLink,
  createLink,
  listLinks,
  getLinkDetail,
  revokeLink,
  listMerchantPayments,
  listSubscribers,
  getMerchantProfile,
  putMerchantProfile,
  verifyMerchantDomain,
  signPayLink,
  stringifyNumbers,
  SessionExpiredError,
  type XenarchConfig,
  type GateResponse,
  type PayLinkLit,
  type PayLinkSchemaResponse,
  type PayLinkValidateResponse,
  type PayLinkCreateResponse,
  type PayLinkListResponse,
  type PayLinkDetail,
  type PayLinkRevokeResponse,
  type MerchantPaymentListResponse,
  type SubscriberListResponse,
  type MerchantProfileResponse,
  type MerchantProfileBody,
} from "@xenarch/core";

import {
  ConfirmationRequired,
  MissingSigningKeyError,
  NotGatedError,
  PayLinkValidationError,
} from "./errors.js";
import { newIdempotencyKey, recordIdempotency } from "./idempotency.js";
import { webhooks } from "./webhooks.js";

const DEFAULT_API_BASE = "https://api.xenarch.dev";
const DEFAULT_RPC_URL = "https://mainnet.base.org";

export interface XenarchOptions {
  /** The `xen_session` cookie value from `xenarch agent login`. Required for merchant ops. */
  sessionToken?: string;
  /** The wallet private key (hex). Required for `links.create` (signs) and `x402.pay`. */
  privateKey?: string;
  /** Platform base URL. Defaults to `https://api.xenarch.dev`. */
  apiBase?: string;
  /** When true (default), `links.create` and `links.revoke` require `{ confirm: true }`. */
  requireConfirm?: boolean;
}

export interface ListOptions {
  limit?: number;
  startingAfter?: string;
}

export interface SubscriberListOptions extends ListOptions {
  linkId?: string;
  status?: string;
  mode?: string;
}

export interface ConfirmOption {
  confirm?: boolean;
}

/**
 * Isomorphic Xenarch client. Two sides of the market under one object:
 * `x402` (pay any 402 URL) and `merchant` (get paid). Plus `webhooks` for
 * verifying incoming events.
 */
export class Xenarch {
  readonly apiBase: string;
  readonly merchant: MerchantNamespace;
  readonly x402: X402Namespace;
  /** Stateless webhook helpers — `webhooks.verify(body, sig, secret)`. */
  readonly webhooks = webhooks;

  private readonly sessionToken?: string;
  private readonly privateKey?: string;
  private readonly requireConfirm: boolean;

  constructor(options: XenarchOptions = {}) {
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.sessionToken = options.sessionToken;
    this.privateKey = options.privateKey;
    this.requireConfirm = options.requireConfirm ?? true;
    this.merchant = new MerchantNamespace(this);
    this.x402 = new X402Namespace(this);
  }

  /**
   * Build a client from the CLI's `~/.xenarch/config.json` (Node only).
   * Pulls the SIWE session, api base, and — for a local wallet — the signing
   * key the session belongs to. Throws `SessionExpiredError` if no session is
   * stored.
   */
  static async fromConfig(
    options: { requireConfirm?: boolean; apiBase?: string } = {},
  ): Promise<Xenarch> {
    const cli = await readCliConfig();
    if (!cli.sessionToken) {
      throw new SessionExpiredError(
        "no session in config — run `xenarch agent login` first",
      );
    }
    return new Xenarch({
      sessionToken: cli.sessionToken,
      privateKey: cli.privateKey,
      apiBase: options.apiBase ?? cli.apiBase ?? DEFAULT_API_BASE,
      requireConfirm: options.requireConfirm,
    });
  }

  /** @internal */
  _session(): string {
    if (!this.sessionToken) {
      throw new SessionExpiredError(
        "no session token — log in with `xenarch agent login` first",
      );
    }
    return this.sessionToken;
  }

  /** @internal */
  _signingKey(): string {
    if (!this.privateKey) throw new MissingSigningKeyError();
    return this.privateKey;
  }

  /** @internal */
  _payConfig(): XenarchConfig {
    return {
      privateKey: this._signingKey(),
      apiBase: this.apiBase,
      rpcUrl: DEFAULT_RPC_URL,
      network: "base",
    };
  }

  /** @internal */
  _ensureConfirmed(confirm: boolean, action: string): void {
    if (this.requireConfirm && !confirm) {
      throw new ConfirmationRequired(
        `refusing to ${action} without confirmation — pass { confirm: true } ` +
          "(or build the client with requireConfirm: false)",
      );
    }
  }
}

/** `createXenarch(options)` — convenience factory for `new Xenarch(options)`. */
export function createXenarch(options: XenarchOptions = {}): Xenarch {
  return new Xenarch(options);
}

// --- x402 (pure-protocol buyer surface) ------------------------------------

export interface PayResult {
  gateId: string;
  txHash: string;
  facilitator: string;
  sellerWallet: string;
  /** The replayed gated response, served after settlement. */
  response: Response;
}

class X402Namespace {
  constructor(private readonly c: Xenarch) {}

  /**
   * Check whether a URL is behind an x402 gate, without paying. Returns
   * `{ gated, gate }` — `gate` carries price, seller wallet, and accepted
   * payment requirements when gated.
   */
  async checkGate(
    url: string,
  ): Promise<{ gated: boolean; gate: GateResponse | null }> {
    return fetchGate(url);
  }

  /**
   * Pay a 402-gated URL and return the unlocked response. Settles USDC on
   * Base, agent wallet to seller wallet, gasless. Throws `NotGatedError` if
   * the URL has no active gate.
   */
  async pay(url: string): Promise<PayResult> {
    const config = this.c._payConfig();
    const { gated, gate } = await fetchGate(url);
    if (!gated || !gate) throw new NotGatedError(url);
    const { response, result } = await payAndFetch(url, config, gate);
    return {
      gateId: gate.gate_id,
      txHash: result.txHash,
      facilitator: result.facilitator,
      sellerWallet: gate.seller_wallet,
      response,
    };
  }
}

// --- merchant (get-paid surface) -------------------------------------------

class MerchantNamespace {
  readonly links: LinksApi;
  readonly payments: PaymentsApi;
  readonly subscribers: SubscribersApi;
  readonly profile: ProfileApi;

  constructor(client: Xenarch) {
    this.links = new LinksApi(client);
    this.payments = new PaymentsApi(client);
    this.subscribers = new SubscribersApi(client);
    this.profile = new ProfileApi(client);
  }
}

class LinksApi {
  constructor(private readonly c: Xenarch) {}

  /** List your pay-links, newest-first. */
  async list(opts: ListOptions = {}): Promise<PayLinkListResponse> {
    return listLinks(this.c.apiBase, this.c._session(), buildQuery(opts));
  }

  /** Full owner detail for one link. */
  async get(linkId: string): Promise<PayLinkDetail> {
    return getLinkDetail(this.c.apiBase, this.c._session(), linkId);
  }

  /** The versioned create-body field descriptor (`GET /v1/links/schema`, auth-free). */
  async schema(): Promise<PayLinkSchemaResponse> {
    return getLinkSchema(this.c.apiBase);
  }

  /** Check a (partial or complete) params tree before signing. `{ ok, missing, errors }`. */
  async validate(params: Record<string, unknown>): Promise<PayLinkValidateResponse> {
    return validateLink(this.c.apiBase, this.c._session(), params);
  }

  /**
   * Sign and create a pay-link. Validates first (throws `PayLinkValidationError`
   * with field-level issues if anything is missing/invalid), then signs the
   * template with the wallet and creates the link. The response carries the
   * one-time `webhook_secret` — store it now; it is never shown again.
   *
   * Signing commits the wallet to the payment terms, so this is confirm-gated:
   * pass `{ confirm: true }` (or build the client with `requireConfirm: false`).
   */
  async create(
    params: Record<string, unknown>,
    opts: ConfirmOption = {},
  ): Promise<PayLinkCreateResponse> {
    this.c._ensureConfirmed(opts.confirm ?? false, "create (sign) a pay-link");
    const token = this.c._session();

    // Coerce any JS numbers in the tree to strings so the locally-hashed
    // params match what the platform re-canonicalizes byte-for-byte (a number
    // like 0.99 would otherwise hash differently than the string "0.99" and
    // fail signature verification). We sign AND post the same coerced tree.
    const safeParams = stringifyNumbers(params) as Record<string, unknown>;

    const validation = await validateLink(this.c.apiBase, token, safeParams);
    if (!validation.ok) {
      throw new PayLinkValidationError(validation.missing, validation.errors);
    }

    const lit = extractLit(safeParams);
    const signed = await signPayLink(this.c._signingKey(), safeParams, lit);
    const key = newIdempotencyKey();
    void recordIdempotency({ key });

    return createLink(
      this.c.apiBase,
      token,
      {
        params: safeParams,
        nonce: signed.nonce,
        created_at: signed.created_at,
        signed_params: signed.signed_params,
      },
      key,
    );
  }

  /** Revoke a link. Irreversible. Confirm-gated. */
  async revoke(
    linkId: string,
    opts: ConfirmOption = {},
  ): Promise<PayLinkRevokeResponse> {
    this.c._ensureConfirmed(opts.confirm ?? false, `revoke link ${linkId}`);
    return revokeLink(this.c.apiBase, this.c._session(), linkId);
  }
}

class PaymentsApi {
  constructor(private readonly c: Xenarch) {}

  /** List payments received across your links, newest-first. */
  async list(opts: ListOptions = {}): Promise<MerchantPaymentListResponse> {
    return listMerchantPayments(this.c.apiBase, this.c._session(), buildQuery(opts));
  }
}

class SubscribersApi {
  constructor(private readonly c: Xenarch) {}

  /** List subscribers, newest-first. Optional `linkId` / `status` / `mode` filters. */
  async list(opts: SubscriberListOptions = {}): Promise<SubscriberListResponse> {
    return listSubscribers(this.c.apiBase, this.c._session(), buildQuery(opts));
  }
}

class ProfileApi {
  constructor(private readonly c: Xenarch) {}

  /** Your merchant profile, or `null` if not set up yet. */
  async show(): Promise<MerchantProfileResponse | null> {
    return getMerchantProfile(this.c.apiBase, this.c._session());
  }

  /** Create or update your merchant profile (whole-state upsert). */
  async update(body: MerchantProfileBody): Promise<MerchantProfileResponse> {
    return putMerchantProfile(this.c.apiBase, this.c._session(), body);
  }

  /** Run domain verification for the profile's `merchant_site`. */
  async verifyDomain(): Promise<MerchantProfileResponse> {
    return verifyMerchantDomain(this.c.apiBase, this.c._session());
  }
}

// --- helpers ---------------------------------------------------------------

interface CliConfig {
  sessionToken?: string;
  privateKey?: string;
  apiBase?: string;
}

/**
 * Read the CLI's `~/.xenarch/config.json` directly (Node only).
 *
 * The signing key MUST be the wallet the SIWE session belongs to, or the
 * platform rejects a create with a signature mismatch. The CLI stores it
 * nested under `wallet.private_key` for a local wallet — we read that
 * explicitly (a `walletconnect` wallet has no local key, so signing ops are
 * unavailable). This mirrors the Python SDK's `from_config`.
 */
async function readCliConfig(): Promise<CliConfig> {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const file = path.join(os.homedir(), ".xenarch", "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  const wallet = (cfg.wallet as Record<string, unknown> | undefined) ?? {};
  const privateKey =
    wallet.type === "local" && typeof wallet.private_key === "string"
      ? wallet.private_key
      : undefined;
  return {
    sessionToken:
      typeof cfg.session_token === "string" ? cfg.session_token : undefined,
    apiBase: typeof cfg.api_base === "string" ? cfg.api_base : undefined,
    privateKey,
  };
}

/** Pull the 5 required lit values from a tagged-shape params tree. */
function extractLit(params: Record<string, unknown>): PayLinkLit {
  const get = (k: string): string => {
    const entry = params[k] as { state?: string; value?: unknown } | undefined;
    if (!entry || typeof entry !== "object" || entry.value === undefined) {
      throw new Error(`params.${k} must be a lit field with a value`);
    }
    if (entry.state !== "lit") {
      throw new Error(
        `params.${k} must be in 'lit' state at creation (got ${String(entry.state)})`,
      );
    }
    return String(entry.value);
  };
  return {
    to: get("to"),
    amount: get("amount"),
    currency: get("currency"),
    network: get("network"),
    kind: get("kind"),
  };
}

/** snake_case query string from list options; drops undefined values. */
function buildQuery(opts: SubscriberListOptions): string {
  const parts: string[] = [];
  const add = (param: string, value: unknown): void => {
    if (value !== undefined && value !== null) {
      parts.push(`${param}=${encodeURIComponent(String(value))}`);
    }
  };
  add("limit", opts.limit);
  add("starting_after", opts.startingAfter);
  add("link_id", opts.linkId);
  add("status", opts.status);
  add("mode", opts.mode);
  return parts.join("&");
}
