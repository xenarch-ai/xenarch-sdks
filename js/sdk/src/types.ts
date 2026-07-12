/**
 * Response/request types for the SDK surface that `@xenarch/core` does not
 * already type. Core's own types (agent caps/scope/keys/receipts, payment
 * history, gate, pay-link create/list/detail, merchant profile, subscriber
 * list) are re-exported from `index.ts` directly.
 *
 * These shapes mirror the platform's response models at the time of writing.
 * Fields the platform may add later are tolerated by the `unknown` index where
 * present; callers should treat unlisted fields as best-effort.
 */

// --- usage ingestion (metered subscriptions) -------------------------------

/** Body for `merchant.usage.report`. `units` is a positive increment, NOT a
 *  running total. `idempotencyKey` dedups retries of the SAME increment. */
export interface UsageReportInput {
  subscriptionId: string;
  /** Positive increment of billable units (e.g. API calls) since last report. */
  units: number | string;
  /** Stable key per increment; replaying the same key is a safe no-op.
   *  Omit to auto-generate (treats the call as a brand-new increment). */
  idempotencyKey?: string;
  /** Which delivery path reported it. Defaults to `webhook` (merchant-reported). */
  source?: "webhook" | "api_gate" | "sdk";
  /** When the usage occurred (ISO-8601). Defaults to server receipt time. */
  occurredAt?: string;
}

export interface UsageReportResponse {
  subscription_id: string;
  /** Running accrued units after this report (decimal string). */
  accrued_units: string;
  /** False when this was a replayed idempotency key (no-op). */
  accepted: boolean;
  deduped: boolean;
}

// --- metered settlement (merchant-pulled, on-chain) ------------------------

export interface MeteredCollectableItem {
  subscription_id: string;
  pay_link_id: string;
  payer_wallet: string;
  charges_booked: number;
  value_micro: number;
  token: string;
  chain_id: number;
  /** The `USDC.transferFrom(owner, spender, value)` the merchant settles with. */
  transfer_from: { owner: string; spender: string; value: number };
}

export interface MeteredCollectableResponse {
  collectable: MeteredCollectableItem[];
  count: number;
  total_micro: number;
}

export interface MeteredCollectResponse {
  subscription_id: string;
  settled_count: number;
  settled_micro: number;
  status: string;
}

export interface MeteredCollectInput {
  /** Hash of the on-chain `transferFrom` the merchant already broadcast. */
  txHash: string;
}

// --- automated collection: ready-to-sign calldata (XEN-634) ----------------

/** One tx to sign+broadcast from your spender. `value` is always `"0"` (no ETH). */
export interface MeteredCollectPrepareStep {
  /** `"permit"` (present only when the permit isn't armed on-chain) or `"transferFrom"`. */
  name: "permit" | "transferFrom";
  /** USDC contract address. */
  to: string;
  /** ABI-encoded calldata (0x-hex). */
  data: string;
  value: string;
}

export interface MeteredCollectPrepareResponse {
  subscription_id: string;
  amount_micro: number;
  amount_usdc: string;
  /** Buyer wallet (`transferFrom` `from`). */
  owner: string;
  /** Your payout wallet = permit spender (`transferFrom` `to`, and the signer). */
  spender: string;
  /** USDC contract address. */
  token: string;
  chain_id: number;
  /**
   * Advisory affordability verdict from the last sweep. `false`/reason means the
   * `transferFrom` step may revert (unfunded wallet); prepare returns the calldata
   * anyway so you can decide. Xenarch never signs — you sign+broadcast the steps.
   */
  collectable: boolean | null;
  collectable_reason: string | null;
  steps: MeteredCollectPrepareStep[];
}

// --- fixed-permit settlement (merchant-pulled) -----------------------------

export interface PermitCollectableItem {
  subscription_id: string;
  pay_link_id: string;
  payer_email: string | null;
  payer_wallet: string;
  cycle: number;
  token: string;
  chain_id: number;
  to: string;
  transfer_from: { owner: string; spender: string; value: number };
  permit: {
    signature: string;
    value: number;
    nonce: number;
    deadline: number;
    submitted: boolean;
  };
}

export interface PermitCollectableResponse {
  collectable: PermitCollectableItem[];
  count: number;
  total_micro: number;
}

export interface PermitCollectResponse {
  subscription_id: string;
  [k: string]: unknown;
}

// --- pay-link extras -------------------------------------------------------

export interface PayLinkEventItem {
  [k: string]: unknown;
}

export interface PayLinkEventsResponse {
  events: PayLinkEventItem[];
  next_cursor: string | null;
}

export interface PayLinkWebhookConfig {
  url: string | null;
  event_types: string[] | null;
  enabled: boolean;
  available_event_types: string[];
}

export interface PayLinkWebhookConfigInput {
  url: string;
  /** Omit/null = subscribe to all events; a list subscribes to just those. */
  eventTypes?: string[] | null;
  enabled?: boolean;
}

export interface LinkGroupAssignResponse {
  link_id: string;
  group_id: string | null;
}

// --- orders ----------------------------------------------------------------

export interface Order {
  order_id: string;
  link_id: string;
  product_name: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  shipping_address: string | null;
  destination: string | null;
  amount_usd: string;
  status: string;
  tracking: string | null;
  tx_hash: string;
  paid_at: string;
}

export interface OrderListResponse {
  orders: Order[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ShipOrderInput {
  tracking: string;
  carrier?: string;
}

// --- earnings --------------------------------------------------------------

export interface EarningsBucket {
  earned_usd: string;
  payment_count: number;
}

export interface EarningsSummaryResponse {
  today: EarningsBucket;
  month: EarningsBucket;
  all_time: EarningsBucket;
}

// --- services --------------------------------------------------------------

export interface ServiceCreateInput {
  name: string;
  url: string;
  description?: string;
  pricePerRequest: number | string;
  category?: "api" | "docs" | "data" | "content";
  payJsonUrl?: string | null;
}

export type ServiceUpdateInput = Partial<ServiceCreateInput>;

export interface ServiceResponse {
  [k: string]: unknown;
}

export interface ServiceListResponse {
  services: ServiceResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface ServiceSearchOptions {
  category?: string;
  q?: string;
  minPrice?: number | string;
  maxPrice?: number | string;
  limit?: number;
  offset?: number;
}

// --- pay-link groups -------------------------------------------------------

export interface GroupCreateInput {
  name: string;
  [k: string]: unknown;
}

export type GroupUpdateInput = Record<string, unknown>;

export interface PayLinkGroup {
  [k: string]: unknown;
}

// --- assets ----------------------------------------------------------------

export interface AssetUploadResponse {
  url: string;
}

// --- public reads ----------------------------------------------------------

export interface UsdcUsdRate {
  pair: string;
  rate: string;
  source: string;
  updated_at: string;
}

export interface WhoisResponse {
  address: string;
  basescan_url: string;
  first_seen_at: string | null;
  tx_count_30d: number | null;
  basename: string | null;
  linked_merchant_profile: Record<string, unknown> | null;
}

export interface ReputationResponse {
  [k: string]: unknown;
}

export interface ReceiptResponse {
  [k: string]: unknown;
}

// --- subscriber status transitions (XEN-558 / XEN-629) ---------------------

/** Result of a merchant status action (suspend / unsuspend). */
export interface SubscriberStatusResult {
  subscription_id: string;
  status: string;
}

// --- link cap suggestions (XEN-625) ----------------------------------------

/**
 * Whole-state PATCH for a metered link's two suggested cap prefills. Decimal
 * USDC strings; `null` clears a suggestion (falls back to the signed param).
 * Not part of signed_params, so this never invalidates the link signature.
 */
export interface CapSuggestionsBody {
  suggested_cap_usdc?: string | null;
  suggested_period_cap_usdc?: string | null;
}

// --- link webhook delivery management (XEN-637) ----------------------------

/** One webhook delivery attempt for a link. `attempted_at` is ISO-8601. */
export interface PayLinkWebhookDeliveryItem {
  id: string;
  event_type: string;
  attempted_at: string;
  dest_url: string;
  /** HTTP status the destination returned; `null` on a transport error. */
  http_status: number | null;
  latency_ms: number;
  retry_count: number;
  error_message: string | null;
  status: string;
}

export interface PayLinkWebhookDeliveriesResponse {
  deliveries: PayLinkWebhookDeliveryItem[];
}

/** One-shot plaintext reveal of the link's webhook signing secret after a rotate. */
export interface PayLinkWebhookSecretResponse {
  webhook_secret: string;
}

/** Donation-link gross received, sub-cent-precise USDC decimal string. */
export interface PayLinkAggregateResponse {
  total_received_usd: string;
}

// --- subscriber reads (XEN-637) --------------------------------------------

/** Portfolio rollup across a merchant's subscribers. `churn_30d` is `null` when the denominator is 0. */
export interface SubscriberRollup {
  active: number;
  /** Monthly recurring revenue, USDC decimal quantized to cents (e.g. `"12.00"`). */
  mrr_usdc: string;
  cancelled_30d: number;
  churn_30d: number | null;
}

export interface SubscriberHistoryItem {
  cycle: number | null;
  tx_hash: string;
  status: "confirmed" | "underpaid" | "overpaid";
  value_usdc: string;
  value_micro_usdc: number;
  block_number: number;
  basescan_url: string;
  created_at: string;
}

/**
 * Full owner-side detail for one subscriber (`subscribers.get`). On the merchant
 * read path `client_reference_id` is populated and `pay_next_url`/`cancel_token`
 * are always `null`. `permit` and `billing` are dynamically-keyed maps (permit-
 * and metered-mode only, `null` otherwise) — treat as open records.
 */
export interface SubscriberDetail {
  subscription_id: string;
  link_id: string;
  is_metered: boolean;
  status:
    | "pending_email_verification"
    | "active"
    | "cancelled"
    | "failed"
    | "exhausted";
  mode: "reminder" | "permit" | "stream";
  issuer_name: string | null;
  plan_name: string | null;
  amount_usdc: string | null;
  amount_micro_usdc: number | null;
  currency: string;
  cadence: string | null;
  cadence_label: string | null;
  next_renewal_at: string | null;
  last_renewal_at: string | null;
  cycles_paid: number;
  payer_email: string | null;
  payer_wallet: string | null;
  client_reference_id: string | null;
  email_status: "ok" | "bounced" | "complained";
  created_at: string;
  history: SubscriberHistoryItem[];
  pay_next_url: string | null;
  cancel_token: string | null;
  permit: Record<string, unknown> | null;
  billing: Record<string, unknown> | null;
}

export interface SubscriberChargeItem {
  charge_seq: number;
  status: "booked" | "settled" | "void";
  accrued_units_billed: string;
  billable_units: string;
  value_usdc: string;
  value_micro_usdc: number;
  booked_at: string;
  tx_hash: string | null;
  settled_at: string | null;
  block_number: number | null;
  basescan_url: string | null;
}

export interface SubscriberChargesResponse {
  subscription_id: string;
  charges: SubscriberChargeItem[];
  has_more: boolean;
  /** Pass as `startingAfter` to page; `null` when no more. Cursor over `charge_seq`. */
  next_cursor: number | null;
  total_charged_micro: number;
  total_collected_micro: number;
  outstanding_micro: number;
}

export interface SubscriberChargesOptions {
  /** 1–200, default 100. */
  limit?: number;
  /** A prior `next_cursor` (charge_seq); returns charges after it. */
  startingAfter?: number;
}

/** Filters for the subscribers CSV export. `status`/`mode` match the list filters. */
export interface SubscriberExportOptions {
  linkId?: string;
  status?: string;
  mode?: string;
}

/** A short-lived payer manage-link the merchant can hand a subscriber. */
export interface ManageLinkResponse {
  manage_url: string;
  manage_token: string;
  expires_at: string;
}

export interface ManageLinkInput {
  /** Link lifetime in seconds; clamped server-side to [60, 86400] (default 900). */
  ttlSeconds?: number;
}

/** Filters for the orders CSV export. */
export interface OrderExportOptions {
  status?: string;
  search?: string;
  linkId?: string;
}

// --- collect() orchestration signer (XEN-634) ------------------------------

/**
 * A minimal signer you supply (e.g. adapted from a viem WalletClient) so
 * `subscribers.collect(...)` can broadcast the prepared steps. The SDK never
 * holds your key — you sign+broadcast, the SDK only orchestrates the sequence.
 */
export interface CollectSigner {
  /** Sign + broadcast a tx to `to` with `data` (value is always "0"); resolve to the tx hash. */
  sendTransaction(tx: { to: string; data: string; value: string }): Promise<string>;
  /** Optionally block until a tx is mined before the next step. */
  waitForReceipt?(hash: string): Promise<unknown>;
}

// --- webhook event typing (XEN-631 / XEN-622) ------------------------------

/** Every pay-link webhook `X-Xenarch-Event` value (mirrors PAY_LINK_EVENT_TYPES). */
export type PayLinkEventType =
  | "payment.confirmed"
  | "payment.underpaid"
  | "payment.overpaid"
  | "subscription.renewed"
  | "charge.booked"
  | "charge.settled"
  | "subscription.status_changed"
  | "webhook.test";

/**
 * `data` payload of a `subscription.status_changed` event (XEN-631): fires on
 * every status transition — negatives (`failed`=suspended, `exhausted`,
 * `cancelled`) AND recoveries (`failed→active`, `exhausted→active`). Branch on
 * `new_status`. `collectable_reason`/`collection_fail_count` are always present
 * (null/0 on non-dunning transitions); `client_reference_id` present when set.
 */
export interface SubscriptionStatusChangedData {
  subscription_id: string;
  link_id: string;
  old_status: string;
  new_status: string;
  collectable_reason: string | null;
  collection_fail_count: number;
  client_reference_id?: string;
}
