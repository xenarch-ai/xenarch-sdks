import {
  fetchGate,
  fetchGateByDomain,
  verifyPayment,
  getPaymentHistory,
  payAndFetch,
  settleX402,
  getMeAgent,
  getAgentSummary,
  getAgentCaps,
  putAgentCaps,
  resetAgentDayCap,
  getAgentScope,
  putAgentScope,
  setAgentPause,
  listAgentKeys,
  createAgentKey,
  rotateAgentKey,
  revokeAgentKey,
  listAgentReceipts,
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
  meSessionRequest,
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
  type VerifiedPaymentResponse,
  type PaymentHistoryItem,
  type MeAgentProfile,
  type AgentSummary,
  type AgentCaps,
  type AgentCapsPut,
  type CapResetResult,
  type ScopeReadResult,
  type ScopeMode,
  type ScopeRuleInput,
  type PauseResult,
  type AgentApiKeySummary,
  type AgentApiKeyIssued,
  type AgentReceiptList,
} from "@xenarch/core";

import {
  ConfirmationRequired,
  MissingSigningKeyError,
  NotGatedError,
  PayLinkValidationError,
} from "./errors.js";
import { bearerRequest, publicRequest, sessionMultipart, toQuery } from "./http.js";
import { newIdempotencyKey, recordIdempotency } from "./idempotency.js";
import type {
  UsageReportInput,
  UsageReportResponse,
  MeteredCollectableResponse,
  MeteredCollectResponse,
  MeteredCollectInput,
  MeteredCollectPrepareResponse,
  SubscriberStatusResult,
  CapSuggestionsBody,
  CollectSigner,
  PermitCollectableResponse,
  PermitCollectResponse,
  PayLinkEventsResponse,
  PayLinkWebhookConfig,
  PayLinkWebhookConfigInput,
  LinkGroupAssignResponse,
  OrderListResponse,
  Order,
  ShipOrderInput,
  EarningsSummaryResponse,
  ServiceCreateInput,
  ServiceUpdateInput,
  ServiceResponse,
  ServiceListResponse,
  ServiceSearchOptions,
  GroupCreateInput,
  GroupUpdateInput,
  PayLinkGroup,
  AssetUploadResponse,
  UsdcUsdRate,
  WhoisResponse,
  ReputationResponse,
  ReceiptResponse,
} from "./types.js";
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
  /** Agent control plane — caps, scope, API keys, receipts. */
  readonly agent: AgentNamespace;
  /** Unauthenticated public reads — receipts, reputation, rates, whois. */
  readonly info: PublicNamespace;
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
    this.agent = new AgentNamespace(this);
    this.info = new PublicNamespace(this);
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

  /** Look up the active gate for a domain (no URL fetch). `null` if none. */
  async checkGateByDomain(domain: string): Promise<GateResponse | null> {
    return fetchGateByDomain(this.c.apiBase, domain);
  }

  /**
   * Settle a gate's x402 envelope on-chain WITHOUT a publisher re-fetch — the
   * pay-link counterpart to `pay`. Returns the tx hash + facilitator. Finalize
   * a pay-link separately via its claim flow.
   */
  async settle(
    gate: GateResponse,
  ): Promise<{ txHash: string; facilitator: string }> {
    return settleX402(this.c._payConfig(), gate);
  }

  /** Verify a settled payment against a gate. */
  async verifyPayment(
    gateId: string,
    txHash: string,
  ): Promise<VerifiedPaymentResponse> {
    return verifyPayment(this.c.apiBase, gateId, txHash);
  }

  /** On-chain payment history for a wallet address. */
  async paymentHistory(
    walletAddress: string,
    options?: { domain?: string; limit?: number },
  ): Promise<PaymentHistoryItem[]> {
    return getPaymentHistory(this.c.apiBase, walletAddress, options);
  }
}

// --- agent control plane ---------------------------------------------------

/**
 * The agent's own control plane (SIWE session = the agent's wallet). Manage
 * spend caps, scope rules, API keys, and read receipts/summary. Mirrors the
 * `xenarch agent …` CLI and the `/v1/me/agent/*` endpoints.
 */
class AgentNamespace {
  readonly keys: AgentKeysApi;

  constructor(private readonly c: Xenarch) {
    this.keys = new AgentKeysApi(c);
  }

  /** The agent's profile (`GET /v1/me/agent`). */
  async profile(): Promise<MeAgentProfile> {
    return getMeAgent(this.c.apiBase, this.c._session());
  }

  /** Usage/spend summary for a period (default the platform's default window). */
  async summary(period?: string): Promise<AgentSummary> {
    return getAgentSummary(this.c.apiBase, this.c._session(), period);
  }

  /** Current spend caps. */
  async getCaps(): Promise<AgentCaps> {
    return getAgentCaps(this.c.apiBase, this.c._session());
  }

  /** Set spend caps (whole-state). */
  async setCaps(caps: AgentCapsPut): Promise<AgentCaps> {
    return putAgentCaps(this.c.apiBase, this.c._session(), caps);
  }

  /** Reset the rolling day cap counter. */
  async resetDayCap(): Promise<CapResetResult> {
    return resetAgentDayCap(this.c.apiBase, this.c._session());
  }

  /** Read the scope ruleset (`{ default_mode, rules }`). */
  async getScope(): Promise<ScopeReadResult> {
    return getAgentScope(this.c.apiBase, this.c._session());
  }

  /** Replace the scope ruleset (whole-state). */
  async setScope(
    defaultMode: ScopeMode,
    rules: ScopeRuleInput[],
  ): Promise<ScopeReadResult> {
    return putAgentScope(this.c.apiBase, this.c._session(), defaultMode, rules);
  }

  /** Pause or resume the agent (blocks/allows spending). */
  async setPaused(paused: boolean): Promise<PauseResult> {
    return setAgentPause(this.c.apiBase, this.c._session(), paused);
  }

  /** Receipts for the agent's payments. */
  async receipts(query?: string): Promise<AgentReceiptList> {
    return listAgentReceipts(this.c.apiBase, this.c._session(), query);
  }
}

class AgentKeysApi {
  constructor(private readonly c: Xenarch) {}

  /** List the agent's API keys (secrets are never returned after issue). */
  async list(): Promise<AgentApiKeySummary[]> {
    return listAgentKeys(this.c.apiBase, this.c._session());
  }

  /** Issue a new API key. The plaintext secret is returned once — store it now. */
  async create(label: string | null = null): Promise<AgentApiKeyIssued> {
    return createAgentKey(this.c.apiBase, this.c._session(), label);
  }

  /** Rotate a key: revoke the old secret, return a fresh one. */
  async rotate(keyId: string): Promise<AgentApiKeyIssued> {
    return rotateAgentKey(this.c.apiBase, this.c._session(), keyId);
  }

  /** Revoke a key immediately. */
  async revoke(keyId: string): Promise<void> {
    return revokeAgentKey(this.c.apiBase, this.c._session(), keyId);
  }
}

// --- merchant (get-paid surface) -------------------------------------------

class MerchantNamespace {
  readonly links: LinksApi;
  readonly payments: PaymentsApi;
  readonly subscribers: SubscribersApi;
  readonly profile: ProfileApi;
  readonly usage: UsageApi;
  readonly orders: OrdersApi;
  readonly services: ServicesApi;
  readonly groups: GroupsApi;
  readonly assets: AssetsApi;
  readonly earnings: EarningsApi;

  constructor(client: Xenarch) {
    this.links = new LinksApi(client);
    this.payments = new PaymentsApi(client);
    this.subscribers = new SubscribersApi(client);
    this.profile = new ProfileApi(client);
    this.usage = new UsageApi(client);
    this.orders = new OrdersApi(client);
    this.services = new ServicesApi(client);
    this.groups = new GroupsApi(client);
    this.assets = new AssetsApi(client);
    this.earnings = new EarningsApi(client);
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

  /** Paged event log for one link. `after` = a prior `next_cursor`. */
  async events(
    linkId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<PayLinkEventsResponse> {
    const qs = toQuery({ after: opts.after, limit: opts.limit });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/links/${encodeURIComponent(linkId)}/events${qs ? `?${qs}` : ""}`,
    );
  }

  /** Aggregate KPIs across all your links. */
  async summary(): Promise<Record<string, unknown>> {
    return meSessionRequest(this.c.apiBase, this.c._session(), "GET", "/v1/links/summary");
  }

  /** Per-link rollup (counts/totals), newest-first. */
  async rollup(opts: ListOptions = {}): Promise<Record<string, unknown>> {
    const qs = buildQuery(opts);
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/links/rollup${qs ? `?${qs}` : ""}`,
    );
  }

  /** Read the webhook config for a link. */
  async getWebhook(linkId: string): Promise<PayLinkWebhookConfig> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/links/${encodeURIComponent(linkId)}/webhook`,
    );
  }

  /** Set the webhook config (whole-state). Omit `eventTypes` to receive all events. */
  async setWebhook(
    linkId: string,
    config: PayLinkWebhookConfigInput,
  ): Promise<PayLinkWebhookConfig> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PUT",
      `/v1/links/${encodeURIComponent(linkId)}/webhook`,
      {
        url: config.url,
        event_types: config.eventTypes ?? null,
        enabled: config.enabled ?? true,
      },
    );
  }

  /** Replace the merchant-facing metadata bag on a link (whole-state PATCH). */
  async updateMetadata(
    linkId: string,
    metadata: Record<string, unknown>,
  ): Promise<PayLinkDetail> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PATCH",
      `/v1/links/${encodeURIComponent(linkId)}/metadata`,
      { metadata },
    );
  }

  /**
   * Set a metered link's two suggested cap prefills (whole-state PATCH, XEN-625).
   * Decimal USDC strings; `null` clears a suggestion. Not signed, so this never
   * invalidates the link signature or disturbs an active checkout.
   */
  async capSuggestions(
    linkId: string,
    body: CapSuggestionsBody,
  ): Promise<PayLinkDetail> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PATCH",
      `/v1/links/${encodeURIComponent(linkId)}/cap-suggestions`,
      body,
    );
  }

  /** Move a link into a group, or out of any group with `groupId = null`. */
  async assignGroup(
    linkId: string,
    groupId: string | null,
  ): Promise<LinkGroupAssignResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PATCH",
      `/v1/links/${encodeURIComponent(linkId)}/group`,
      { group_id: groupId },
    );
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

  /**
   * The metered "collectable bag": booked-but-unsettled metered charges across
   * your links, grouped by subscriber. Each row carries the total to pull and
   * the `(owner, spender, value)` for the `USDC.transferFrom` you broadcast to
   * settle — Xenarch never moves money. Optionally scope to one `linkId`.
   */
  async meteredCollectable(
    opts: { linkId?: string } = {},
  ): Promise<MeteredCollectableResponse> {
    const qs = toQuery({ link_id: opts.linkId });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/subscribers/metered/collectable${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Record an on-chain settlement of a metered subscriber's booked charges.
   * Pass the `txHash` of the `transferFrom` you already broadcast; the platform
   * verifies it on-chain, marks the covered charges settled, and draws down the
   * permit allowance. Exactly-once on `txHash`.
   */
  async meteredCollect(
    subscriptionId: string,
    input: MeteredCollectInput,
  ): Promise<MeteredCollectResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/metered/collect`,
      { tx_hash: input.txHash },
    );
  }

  /**
   * Fixed-permit "collectable bag": this cycle's due charges across your
   * permit-mode subscribers, each with the `transferFrom` + signed permit to
   * settle on-chain. Optionally scope to one `linkId`.
   */
  async permitCollectable(
    opts: { linkId?: string } = {},
  ): Promise<PermitCollectableResponse> {
    const qs = toQuery({ link_id: opts.linkId });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/subscribers/permit/collectable${qs ? `?${qs}` : ""}`,
    );
  }

  /** Record an on-chain settlement of a fixed-permit subscriber's due cycle. */
  async permitCollect(
    subscriptionId: string,
    input: MeteredCollectInput,
  ): Promise<PermitCollectResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/permit/collect`,
      { tx_hash: input.txHash },
    );
  }

  /** Merchant-side cancel of a subscription. */
  async cancel(subscriptionId: string): Promise<Record<string, unknown>> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/merchant-cancel`,
    );
  }

  /** Suspend a subscription (`status → "failed"`). Idempotent; non-custodial. */
  async suspend(subscriptionId: string): Promise<SubscriberStatusResult> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/suspend`,
    );
  }

  /**
   * Lift a suspension: `failed → active` (or `exhausted` if the permit is fully
   * drawn). Clears the dunning counter. Idempotent; non-custodial (XEN-629).
   */
  async unsuspend(subscriptionId: string): Promise<SubscriberStatusResult> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/unsuspend`,
    );
  }

  /**
   * Ready-to-sign calldata for collecting a metered subscriber's outstanding
   * booked charges (XEN-634). Returns the `permit()` (only if not armed) +
   * `transferFrom()` steps; you sign+broadcast each from your spender, then
   * record via `meteredCollect`. Xenarch never signs. See `collect()` for the
   * one-call flow.
   */
  async meteredCollectPrepare(
    subscriptionId: string,
  ): Promise<MeteredCollectPrepareResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/subscribers/${encodeURIComponent(subscriptionId)}/metered/collect/prepare`,
    );
  }

  /**
   * One-call automated collection (XEN-634): fetch the ready-to-sign steps,
   * have your `signer` broadcast each (permit if needed, then transferFrom),
   * then record the settlement. The dashboard "collect" button as a backend
   * call. Xenarch stays verify-only — your signer moves the money; this only
   * orchestrates the thin calls (like `x402.pay`, it holds no key of its own).
   */
  async collect(
    subscriptionId: string,
    signer: CollectSigner,
  ): Promise<MeteredCollectResponse> {
    const prep = await this.meteredCollectPrepare(subscriptionId);
    let transferHash: string | undefined;
    for (const step of prep.steps) {
      const hash = await signer.sendTransaction({
        to: step.to,
        data: step.data,
        value: step.value,
      });
      if (signer.waitForReceipt) await signer.waitForReceipt(hash);
      if (step.name === "transferFrom") transferHash = hash;
    }
    if (!transferHash) {
      throw new Error("collect: prepare returned no transferFrom step");
    }
    return this.meteredCollect(subscriptionId, { txHash: transferHash });
  }
}

/**
 * Usage ingestion for per-unit metered subscriptions. Authenticated with the
 * pay-link's `webhook_secret` (the one-time secret returned by
 * `links.create`) — NOT the merchant session. A reporting service in your
 * backend only needs the secret, not the merchant wallet.
 */
class UsageApi {
  constructor(private readonly c: Xenarch) {}

  /**
   * Report a usage increment for one metered subscriber. `units` is a positive
   * INCREMENT (calls since the last report), not a running total. Pass a stable
   * `idempotencyKey` per increment so a retried request is deduped to a no-op;
   * omit it to treat the call as a fresh increment.
   *
   * @param linkId  The metered subscription link's id.
   * @param input   `{ subscriptionId, units, idempotencyKey?, source?, occurredAt? }`.
   * @param auth    `{ secret }` — the link's `webhook_secret`.
   */
  async report(
    linkId: string,
    input: UsageReportInput,
    auth: { secret: string },
  ): Promise<UsageReportResponse> {
    return bearerRequest(
      this.c.apiBase,
      auth.secret,
      "POST",
      `/v1/links/${encodeURIComponent(linkId)}/usage`,
      {
        subscription_id: input.subscriptionId,
        units: input.units,
        idempotency_key: input.idempotencyKey ?? newIdempotencyKey(),
        source: input.source ?? "webhook",
        occurred_at: input.occurredAt,
      },
    );
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

// --- orders / fulfilment ---------------------------------------------------

class OrdersApi {
  constructor(private readonly c: Xenarch) {}

  /** List orders (paid + shipped), newest-first. */
  async list(
    opts: ListOptions & { status?: string; linkId?: string } = {},
  ): Promise<OrderListResponse> {
    const qs = toQuery({
      limit: opts.limit,
      starting_after: opts.startingAfter,
      status: opts.status,
      link_id: opts.linkId,
    });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/orders${qs ? `?${qs}` : ""}`,
    );
  }

  /** Mark an order shipped with a tracking number (+ optional carrier). */
  async ship(orderId: string, input: ShipOrderInput): Promise<Order> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "POST",
      `/v1/orders/${encodeURIComponent(orderId)}/ship`,
      { tracking: input.tracking, carrier: input.carrier },
    );
  }
}

// --- services (x402 service registry) --------------------------------------

class ServicesApi {
  constructor(private readonly c: Xenarch) {}

  async create(input: ServiceCreateInput): Promise<ServiceResponse> {
    return meSessionRequest(this.c.apiBase, this.c._session(), "POST", "/v1/services", {
      name: input.name,
      url: input.url,
      description: input.description,
      price_per_request: input.pricePerRequest,
      category: input.category,
      pay_json_url: input.payJsonUrl,
    });
  }

  async list(opts: { limit?: number; offset?: number } = {}): Promise<ServiceListResponse> {
    const qs = toQuery({ limit: opts.limit, offset: opts.offset });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/services${qs ? `?${qs}` : ""}`,
    );
  }

  async search(opts: ServiceSearchOptions = {}): Promise<ServiceListResponse> {
    const qs = toQuery({
      category: opts.category,
      q: opts.q,
      min_price: opts.minPrice,
      max_price: opts.maxPrice,
      limit: opts.limit,
      offset: opts.offset,
    });
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/services/search${qs ? `?${qs}` : ""}`,
    );
  }

  async get(serviceId: string): Promise<ServiceResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "GET",
      `/v1/services/${encodeURIComponent(serviceId)}`,
    );
  }

  async update(serviceId: string, input: ServiceUpdateInput): Promise<ServiceResponse> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PUT",
      `/v1/services/${encodeURIComponent(serviceId)}`,
      {
        name: input.name,
        url: input.url,
        description: input.description,
        price_per_request: input.pricePerRequest,
        category: input.category,
        pay_json_url: input.payJsonUrl,
      },
    );
  }

  async delete(serviceId: string): Promise<Record<string, unknown>> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "DELETE",
      `/v1/services/${encodeURIComponent(serviceId)}`,
    );
  }
}

// --- pay-link groups -------------------------------------------------------

class GroupsApi {
  constructor(private readonly c: Xenarch) {}

  async create(input: GroupCreateInput): Promise<PayLinkGroup> {
    return meSessionRequest(this.c.apiBase, this.c._session(), "POST", "/v1/groups", input);
  }

  async list(): Promise<PayLinkGroup[] | { groups: PayLinkGroup[] }> {
    return meSessionRequest(this.c.apiBase, this.c._session(), "GET", "/v1/groups");
  }

  async update(groupId: string, input: GroupUpdateInput): Promise<PayLinkGroup> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "PATCH",
      `/v1/groups/${encodeURIComponent(groupId)}`,
      input,
    );
  }

  async delete(groupId: string): Promise<void> {
    return meSessionRequest(
      this.c.apiBase,
      this.c._session(),
      "DELETE",
      `/v1/groups/${encodeURIComponent(groupId)}`,
    );
  }
}

// --- assets (image/logo uploads → CDN) -------------------------------------

class AssetsApi {
  constructor(private readonly c: Xenarch) {}

  /**
   * Upload an image (product photo / logo) and get back its public CDN URL.
   * Accepts a `Blob`/`File`; isomorphic (Node 18+, Bun, Deno, edge). Server
   * caps size + restricts to web image types.
   */
  async upload(file: Blob, filename = "upload"): Promise<AssetUploadResponse> {
    const form = new FormData();
    form.append("file", file, filename);
    return sessionMultipart(this.c.apiBase, this.c._session(), "/v1/assets", form);
  }
}

// --- earnings --------------------------------------------------------------

class EarningsApi {
  constructor(private readonly c: Xenarch) {}

  /** Merged gating + pay-link earnings, bucketed today / month / all-time. */
  async summary(): Promise<EarningsSummaryResponse> {
    return meSessionRequest(this.c.apiBase, this.c._session(), "GET", "/v1/earnings/summary");
  }
}

// --- public reads (no auth) ------------------------------------------------

class PublicNamespace {
  constructor(private readonly c: Xenarch) {}

  /** A signed payment receipt by tx hash. */
  async receipt(txHash: string): Promise<ReceiptResponse> {
    return publicRequest(
      this.c.apiBase,
      "GET",
      `/v1/receipts/${encodeURIComponent(txHash)}`,
    );
  }

  /** On-chain reputation signals for a wallet address. */
  async reputation(address: string): Promise<ReputationResponse> {
    return publicRequest(
      this.c.apiBase,
      "GET",
      `/v1/reputation/${encodeURIComponent(address)}`,
    );
  }

  /** Current USDC/USD rate the platform prices fiat displays against. */
  async usdcUsdRate(): Promise<UsdcUsdRate> {
    return publicRequest(this.c.apiBase, "GET", "/v1/rates/usdc-usd");
  }

  /** Public "whois" for a wallet: first-seen, 30d tx count, Basename, verified merchant. */
  async whois(address: string): Promise<WhoisResponse> {
    return publicRequest(
      this.c.apiBase,
      "GET",
      `/v1/wallets/${encodeURIComponent(address)}/whois`,
    );
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
