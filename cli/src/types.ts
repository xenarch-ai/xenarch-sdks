// Xenarch CLI types and contract constants
//
// Post-XEN-179 (no-splitter pivot): the CLI no longer touches a Xenarch
// splitter contract. Payment goes directly from the agent's facilitator
// to the publisher's `seller_wallet` via x402's EIP-3009 settle flow.
// Subsequent gated requests carry `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash`
// headers (see `src/lib/payment.ts`).

// --- Config ---

export interface LocalWalletConfig {
  type: "local";
  address: string;
  private_key: string;
}

export interface WalletConnectConfig {
  type: "walletconnect";
  address: string;
  session_topic: string;
  relay_url: string;
}

export type WalletConfig = LocalWalletConfig | WalletConnectConfig;

export interface Config {
  wallet: WalletConfig | null;
  api_base: string;
  rpc_url: string;
  network: string;
  auth_token: string | null;
  wc_project_id: string | null;
  // SIWE session for the agent control plane (`xenarch agent ...`). The
  // raw `xen_session` cookie value + its ISO expiry. Established by
  // `xenarch agent login`; replayed on /me/agent/* requests.
  session_token: string | null;
  session_expires_at: string | null;
}

export const DEFAULT_CONFIG: Config = {
  wallet: null,
  api_base: "https://api.xenarch.dev",
  rpc_url: "https://mainnet.base.org",
  network: "base",
  auth_token: null,
  wc_project_id: null,
  session_token: null,
  session_expires_at: null,
};

// --- API Responses ---

/** One x402 v1 PaymentRequirements entry inside a 402 response. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

/** One facilitator the agent may settle through. */
export interface FacilitatorOption {
  name: string;
  url: string;
  spec_version: string;
}

/**
 * Response body for an HTTP 402 issued by a Xenarch-protected resource.
 *
 * Post-XEN-179: no `splitter`, no `collector`. Payment goes directly from
 * the agent's facilitator to `seller_wallet`. The agent picks a facilitator
 * from `facilitators` (or its own preference list — see {@link Router}) to
 * settle through.
 */
export interface GateResponse {
  xenarch: true;
  gate_id: string;
  price_usd: string;
  seller_wallet: string;
  network: string;
  asset: string;
  protocol: string;
  facilitators: FacilitatorOption[];
  accepts: PaymentRequirements[];
  verify_url: string;
  expires: string;
}

export interface GateVerifyRequest {
  tx_hash: string;
}

/**
 * Response from POST /v1/gates/{id}/verify.
 *
 * Post-XEN-179: no access token. The platform returns the verified payment
 * record; subsequent gated requests carry `gate_id` + `tx_hash` so the
 * publisher edge can re-verify statelessly.
 */
export interface VerifiedPaymentResponse {
  gate_id: string;
  status: string; // "paid"
  tx_hash: string;
  amount_usd: string;
  verified_at: string;
}

export interface GateStatusResponse {
  gate_id: string;
  status: "pending" | "paid" | "expired";
  price_usd: string;
  created_at: string;
  paid_at: string | null;
}

export interface AgentRegisterRequest {
  wallet_address: string;
  name?: string;
}

export interface AgentRegisterResponse {
  id: string;
  wallet_address: string;
  created_at: string;
}

export interface ApiError {
  error: string;
  message: string;
  code: number;
}

// --- Publisher API Responses ---

export interface PublisherRegisterResponse {
  id: string;
  api_key: string;
}

export interface SiteCreateResponse {
  id: string;
  site_token: string;
}

export interface SiteListItem {
  id: string;
  domain: string;
  default_price_usd: string;
  created_at: string;
}

export interface SiteStatsResponse {
  total_gates: number;
  total_paid: number;
  revenue_usd: string;
  period: string;
  top_pages: Array<{ url: string; count: number; revenue_usd: string }>;
  top_agents: Array<{ wallet: string; count: number; total_usd: string }>;
}

// --- Sites & gating (SIWE: /v1/me/sites/*, /v1/me/publisher/*) (XEN-518) ---
// Money fields (default_price_usd, price_usd, amount_usd) arrive as JSON
// strings (Decimal); gated_categories maps a category name → gated bool.

export interface PriceRuleItem {
  path: string;
  price_usd: string;
  billing_scope: "page" | "path";
}

/** GET /v1/me/sites/{id} — full owner detail (gating + pricing + rules). */
export interface SiteDetail {
  id: string;
  domain: string | null;
  default_price_usd: string;
  default_billing_scope: string;
  integration_type: string | null;
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  site_token_hash: string;
  created_at: string;
  use_publisher_defaults: boolean;
  rules: PriceRuleItem[];
}

/** PUT /v1/me/sites/{id}/pricing body (full replace). */
export interface SitePricingBody {
  default_price_usd: string;
  default_billing_scope: "page" | "path";
  rules: PriceRuleItem[];
}

export interface SitePricingResult {
  rules_applied: number;
}

/** PUT /v1/me/sites/{id}/gating body (full replace). */
export interface SiteGatingBody {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  use_publisher_defaults: boolean;
}

export interface SiteGatingResult {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  use_publisher_defaults: boolean;
}

export interface RotateTokenResult {
  site_token: string;
}

export interface SiteTransactionItem {
  id: string;
  type: string;
  path: string;
  agent_name: string | null;
  amount_usd: string;
  status: string;
  created_at: string;
}

export interface SiteTransactionsResponse {
  transactions: SiteTransactionItem[];
  total: number;
  page: number;
  per_page: number;
}

export interface CategoryBreakdownResponse {
  categories: Array<{ category: string; earned_usd: string }>;
}

/** GET/PUT /v1/me/publisher/gating — publisher-level gating defaults. */
export interface PublisherGating {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  bot_overrides: Record<string, string>;
  publisher_id: string;
}

/** PUT body — `bot_overrides` omitted preserves the existing map. */
export interface PublisherGatingBody {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  bot_overrides?: Record<string, string>;
}

/** POST /v1/me/site-claims body + response. */
export interface SiteClaimBody {
  integration_type: "wp" | "joomla" | "cf" | "sdk" | "cli" | "custom";
  domain: string;
}

export interface SiteClaimResult {
  site_id: string;
  claim_token: string;
  domain: string;
  integration_type: string;
  expires_in: number;
}

// --- Bots (GET /v1/bot-catalog public; /v1/me/publisher/bot-activity SIWE) ---

export interface BotCatalogResponse {
  categories: string[];
  signatures: Array<{ name: string; category: string; company: string }>;
  count: number;
}

export interface BotActivityItem {
  signature: string;
  category: string;
  company: string;
  sites_seen: number;
  hit_count: number;
  last_seen: string;
  first_seen: string;
}

export interface BotActivityResponse {
  activity: BotActivityItem[];
  total_signatures: number;
  window_days: number;
}

// --- Pay-link detail surface, groups, orders, webhooks (XEN-518, SIWE) ------

export interface PayLinkEventItem {
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface PayLinkEventsResponse {
  events: PayLinkEventItem[];
  next_cursor: string | null;
}

/** GET /v1/links/rollup — merchant pay-link KPIs. */
export interface PayLinkRollup {
  paid_24h: number;
  paid_total: number;
  mtd_revenue_usdc: string;
  views: number;
  conversion: number | null;
}

/** GET /v1/links/summary?period=… */
export interface PayLinkSummary {
  period: string;
  revenue_usd: string;
  paid_count: number;
  link_count: number;
}

/** PATCH /v1/links/{id}/metadata body (whole-state; null clears). */
export interface PayLinkMetadataBody {
  metadata: Record<string, unknown> | null;
}

/** PATCH /v1/links/{id}/group result. */
export interface LinkGroupAssignResult {
  link_id: string;
  group_id: string | null;
}

export interface Group {
  id: string;
  name: string;
  accent_kind: string;
  position: number;
  created_at: string;
  updated_at: string;
  member_link_ids: string[];
  member_count: number;
}

export interface GroupCreateBody {
  name: string;
  accent_kind?: string;
}

export interface GroupUpdateBody {
  name?: string;
  accent_kind?: string;
  position?: number;
}

export interface GroupListResponse {
  groups: Group[];
}

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

export interface ShipOrderBody {
  tracking: string;
  carrier?: string;
}

/** GET/PUT /v1/links/{id}/webhook. */
export interface WebhookConfig {
  url: string | null;
  event_types: string[] | null;
  enabled: boolean;
  available_event_types: string[];
}

export interface WebhookConfigBody {
  url: string;
  event_types?: string[] | null;
  enabled: boolean;
}

export interface WebhookSecretResult {
  webhook_secret: string;
}

export interface WebhookDeliveryItem {
  id: string;
  event_type: string;
  attempted_at: string;
  dest_url: string;
  http_status: number | null;
  latency_ms: number;
  retry_count: number;
  error_message: string | null;
  status: string;
}

export interface WebhookDeliveriesResponse {
  deliveries: WebhookDeliveryItem[];
}

// --- Account & identity, agent profile/webhooks, earnings (XEN-518, SIWE) ---

/** PUT /v1/me/agent body — agent display profile. */
export interface MeAgentUpdateBody {
  display_name?: string | null;
  label?: string | null;
}

/** GET/PUT /v1/me/agent/webhooks. Note: differs from the pay-link shape. */
export interface AgentWebhookConfig {
  configured: boolean;
  url: string | null;
  event_types: string[] | null;
  enabled: boolean;
  available_event_types: string[];
}

export interface AgentWebhookConfigBody {
  url: string;
  event_types?: string[] | null;
  enabled: boolean;
}

/** POST /v1/me/agent/webhooks/rotate-secret — note `secret`, not webhook_secret. */
export interface AgentWebhookSecretResult {
  secret: string;
}

export interface AgentWebhookDeliveryItem {
  id: string;
  event_type: string;
  attempted_at: string;
  dest_url: string;
  http_status: number | null;
  latency_ms: number;
  retry_count: number;
  status: string;
  error_message: string | null;
}

export interface AgentWebhookDeliveriesResponse {
  deliveries: AgentWebhookDeliveryItem[];
}

/** GET /v1/me/wallets — one linked wallet. */
export interface LinkedWalletItem {
  address: string;
  verified_at: string;
  is_primary: boolean;
  eligible_at: string;
  eligible: boolean;
  is_default: boolean;
  is_owner: boolean;
  label: string | null;
}

export interface MeWalletsListResponse {
  wallets: LinkedWalletItem[];
}

export interface OwnerTransferResult {
  owner_wallet: string;
}

/** GET/POST/rotate /v1/me/merchant/keys. */
export interface MerchantApiKeySummary {
  id: string;
  label: string | null;
  hash_preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MerchantApiKeyIssued extends MerchantApiKeySummary {
  /** Plaintext `xm_live_*` token — returned once. */
  plaintext: string;
}

/** POST /v1/me/wallets/invite. */
export interface InviteCreateBody {
  label?: string | null;
  role?: "viewer" | "operator" | "full_co_owner";
}

export interface InviteCreateResult {
  token: string;
  join_url: string;
  expires_at: string;
  label: string | null;
  role: string;
}

export interface InviteItem {
  id: string;
  label: string | null;
  role: string;
  created_by_wallet: string;
  created_at: string;
  expires_at: string;
}

export interface InvitesListResponse {
  invites: InviteItem[];
}

/** POST /v1/onboarding/email(+/verify). */
export interface OnboardingEmailResult {
  email: string;
  sent: boolean;
}

export interface OnboardingEmailVerifyResult {
  identity_id: string;
  email: string;
  email_verified_at: string;
}

/** GET /v1/earnings/summary. */
export interface EarningsBucket {
  earned_usd: string;
  payment_count: number;
}

export interface EarningsSummary {
  today: EarningsBucket;
  month: EarningsBucket;
  all_time: EarningsBucket;
}

// --- Payment History Cache ---

/**
 * One entry in the local payment history cache.
 *
 * Post-XEN-179: no access token. Cached entries record the on-chain tx
 * hash so the user can replay {@link GateResponse.gate_id} +
 * {@link CachedPayment.tx_hash} headers against the same URL until the
 * publisher's verification window closes.
 */
export interface CachedPayment {
  url: string;
  gate_id: string;
  price_usd: string;
  tx_hash: string;
  facilitator: string;
  paid_at: string;
}

// --- Payment ---

/**
 * Result of a successful settle through a third-party x402 facilitator.
 *
 * The caller is responsible for replaying the URL with
 * `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash` headers — see the pay command.
 */
export interface PaymentResult {
  tx_hash: string;
  facilitator: string;
  gate_id: string;
  amount_usd: string;
}

// --- Pay.json ---

export interface PayJsonPricing {
  default_price_usd?: number;
  rules?: Array<{
    path: string;
    price_usd: number;
  }>;
}

// --- Contract Constants ---

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
] as const;

// --- Replay headers (post-XEN-179) ---

/**
 * Canonical Xenarch replay headers. Lowercase comparison only — fetch
 * normalises header casing and the publisher middleware reads them
 * lowercase too.
 */
export const GATE_ID_HEADER = "X-Xenarch-Gate-Id";
export const TX_HASH_HEADER = "X-Xenarch-Tx-Hash";

// --- Agent control plane (SIWE: /v1/me/agent/*) ---
//
// Mirrors app/schemas/agents.py. USD amounts arrive as JSON strings
// (Decimal); the CLI treats them as strings and never does float math.

export const SESSION_COOKIE_NAME = "xen_session";

export interface SiweNonceResponse {
  nonce: string;
  issued_at: string;
  expires_at: string;
}

export interface MeAgentProfile {
  id: string;
  display_name: string | null;
  label: string | null;
  paused: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentSummary {
  period: string;
  total_usd: string;
  count: number;
  by_source: Record<string, string>;
}

/** GET /caps + the read returned by PUT /caps. `null` on an axis = disabled. */
export interface AgentCaps {
  per_tx_usd: string | null;
  daily_usd: string | null;
  monthly_usd: string | null;
  remaining_today: string | null;
  remaining_month: string | null;
  resets_today_at: string;
  resets_month_at: string;
  updated_at: string | null;
}

/** PUT /caps body — full replace: an omitted axis disables that cap. */
export interface AgentCapsPut {
  per_tx_usd: string | null;
  daily_usd: string | null;
  monthly_usd: string | null;
}

export interface CapResetResult {
  reset_axis: "day" | "month";
  new_remaining: string | null;
  resets_at: string;
}

export type ScopeMode = "allow" | "deny";

export interface ScopeRuleItem {
  id: string;
  pattern: string;
  mode: ScopeMode;
  label: string | null;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScopeReadResult {
  default_mode: ScopeMode;
  rules: ScopeRuleItem[];
}

/** PUT /scope body — full replace of the rule set. */
export interface ScopeRuleInput {
  pattern: string;
  mode: ScopeMode;
  label?: string | null;
}

export interface PauseResult {
  paused: boolean;
  updated_at: string;
}

export interface AgentApiKeySummary {
  id: string;
  label: string | null;
  hash_preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AgentApiKeyIssued extends AgentApiKeySummary {
  /** Plaintext `xa_live_*` token — returned exactly once. */
  plaintext: string;
}

export interface AgentReceiptItem {
  id: string;
  url: string;
  domain: string;
  amount_usd: string;
  tx_hash: string | null;
  facilitator: string | null;
  source: string;
  status: string;
  paid_at: string;
  created_at: string;
  chain_verified: boolean;
}

export interface AgentReceiptList {
  receipts: AgentReceiptItem[];
  total: number;
  page: number;
  per_page: number;
}

// --- Merchant ops (SIWE: /v1/links, /v1/payments, /v1/subscribers,
//     /v1/merchant-profile). Mirrors the platform schemas. USD amounts are
//     JSON strings (Decimal); never do float math on them. ---

/** GET /v1/links/schema — one field of the create-body descriptor. */
export interface PayLinkSchemaField {
  field: string;
  group: string;
  type: string;
  required: boolean;
  state: string;
  prompt: string;
  advanced: boolean;
  enum: string[] | null;
  default: string | null;
  auto_fill: string | null;
  help: string | null;
}

export interface PayLinkSchemaResponse {
  version: string;
  currency: { default: string; supported: string[] };
  network: { default: string; supported: string[] };
  max_amount_usd: string;
  fields: PayLinkSchemaField[];
}

/** POST /v1/links/validate — one problem with a field. */
export interface PayLinkFieldIssue {
  field: string;
  message: string;
  prompt?: string | null;
  group?: string | null;
  type?: string | null;
  enum?: string[] | null;
}

export interface PayLinkValidateResponse {
  ok: boolean;
  missing: PayLinkFieldIssue[];
  errors: PayLinkFieldIssue[];
}

/** A tagged param value: lit fields carry a value; tok/auto declare a slot. */
export interface LitValue {
  state: "lit";
  value: unknown;
}

/** POST /v1/links body. `params` is the tagged tree; the rest is the signature. */
export interface PayLinkCreateBody {
  params: Record<string, unknown>;
  nonce: string;
  created_at: number;
  signed_params: string;
}

export interface PayLinkCreateResponse {
  link_id: string;
  link: string;
  qr_png_url: string | null;
  embed_html: string | null;
  webhook_secret: string;
  signed_params: string;
  created_at: string;
}

export interface PayLinkListItem {
  link_id: string;
  created_at: string;
  expires_at: string | null;
  kind: string;
  status: string;
  paid_and_single_use: boolean;
  paid_count: number;
  amount_usd: string | null;
  cadence: string | null;
}

export interface PayLinkListResponse {
  links: PayLinkListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

/** GET /v1/links/{id} owner detail — permissive; we surface key fields + raw. */
export interface PayLinkDetail {
  link_id: string;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  link?: string;
  params?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  latest_payment?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PayLinkRevokeResponse {
  revoked: boolean;
  link_id: string;
  revoked_at: string | null;
}

export interface MerchantPaymentItem {
  id: string;
  link_id: string;
  tx_hash: string;
  from_address: string;
  amount_usd: string;
  expected_usd: string;
  status: string;
  subscription_id: string | null;
  cycle: number | null;
  created_at: string;
}

export interface MerchantPaymentListResponse {
  payments: MerchantPaymentItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SubscriberListItem {
  subscription_id: string;
  pay_link_id: string;
  payer_email: string | null;
  payer_wallet: string | null;
  mode: "reminder" | "permit" | "stream";
  status: string;
  email_status: string;
  cycles_paid: number;
  next_renewal_at: string | null;
  last_renewal_at: string | null;
  created_at: string;
  amount_usd: string | null;
  cadence: string | null;
  // XEN-611 dunning surface. `collectable` is the sweep-cached affordability
  // verdict (true/false/null=unchecked); `collection_fail_count` is the
  // consecutive due-cycle failure count (0..5). Together they render
  // "dunning (n/5)" without a second fetch. Additive — older servers omit them.
  collectable?: boolean | null;
  collectable_reason?: string | null;
  collection_fail_count?: number;
}

export interface SubscriberListResponse {
  subscribers: SubscriberListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * GET /v1/subscribers/{id} owner detail — permissive; we surface key fields +
 * carry the raw body (same shape strategy as {@link PayLinkDetail}).
 */
export interface SubscriberDetail {
  subscription_id: string;
  link_id: string;
  is_metered: boolean;
  status: string;
  mode: "reminder" | "permit" | "stream";
  issuer_name: string | null;
  plan_name: string | null;
  amount_usdc: string | null;
  currency: string;
  cadence: string | null;
  cadence_label: string | null;
  next_renewal_at: string | null;
  last_renewal_at: string | null;
  cycles_paid: number;
  payer_email: string | null;
  payer_wallet: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** One row of the immutable per-subscriber metered charge ledger (XEN-483). */
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
  next_cursor: number | null;
  total_charged_micro: number;
  total_collected_micro: number;
  outstanding_micro: number;
}

/** POST /v1/subscribers/{id}/merchant-cancel + /suspend. */
export interface SubscriberCancelResponse {
  subscription_id: string;
  status: string;
}

/** POST /v1/subscribers/{id}/manage-link — short-lived hosted-manage-page URL. */
export interface ManageLinkResponse {
  manage_url: string;
  manage_token: string;
  expires_at: string;
}

/** GET /v1/subscribers/rollup — subscriber KPIs hero. */
export interface SubscribersRollup {
  active: number;
  mrr_usdc: string;
  churn_30d: number | null;
}

/** POST /v1/subscribers/{id}/period-cap result. */
export interface PeriodCapResult {
  subscription_id: string;
  status: string;
  period_cap_micro: number | null;
  period_cap_usdc: string;
  exceeds_permit_runway: boolean;
  remaining_permit_micro: number;
}

/**
 * GET /v1/subscribers/permit|metered/collectable — the "collectable bag".
 * Read-only: Xenarch never submits the on-chain transferFrom. Rows are
 * permissive (permit vs metered rows differ); we surface the key fields.
 */
export interface CollectableRow {
  subscription_id: string;
  pay_link_id: string;
  payer_email: string | null;
  payer_wallet: string | null;
  to: string;
  transfer_from: { owner: string | null; spender: string | null; value: number };
  [key: string]: unknown;
}

export interface CollectableResponse {
  collectable: CollectableRow[];
  count: number;
  total_micro: number;
}

/**
 * POST /v1/subscribers/{id}/permit|metered/collect result — the booked cycle /
 * settled charges after the merchant's on-chain transferFrom is recorded.
 * Permissive: we surface the key fields and carry the raw body.
 */
export interface CollectRecordResult {
  subscription_id?: string;
  status?: string;
  cycle?: number | null;
  tx_hash?: string;
  value_usdc?: string;
  [key: string]: unknown;
}

/** Writable merchant-profile fields (PUT body). */
export interface MerchantProfileBody {
  issuer_name?: string | null;
  issuer_logo_url?: string | null;
  issuer_address?: string | null;
  issuer_tax_id?: string | null;
  issuer_email?: string | null;
  merchant_site?: string | null;
  brand_color?: string | null;
  collection_rhythm?: "daily" | "weekly" | "monthly" | "never" | null;
}

/** GET/PUT /v1/merchant-profile response. */
export interface MerchantProfileResponse extends MerchantProfileBody {
  id: string;
  identity_id: string;
  updated_at: string;
  verification_token: string;
  domain_verified_at: string | null;
}

/** POST /v1/links/{id}/initiate — x402 envelope (returned with HTTP 402). */
export interface PayLinkInitiateResponse {
  x402Version: number;
  accepts: PaymentRequirements[];
  facilitators: FacilitatorOption[];
  link_id: string;
  network: string;
  asset: string;
  protocol: string;
  expires: string | null;
  error: string | null;
}

/** POST /v1/links/{id}/claim — payment attempt recorded from the on-chain tx. */
export interface PayLinkClaimResponse {
  attempt_id: string;
  tx_hash: string;
  status: "confirmed" | "underpaid" | "overpaid";
  value_usdc: string;
  expected_usdc: string;
  block_number: number;
  paid_and_single_use: boolean;
  created: boolean;
  manage_url: string | null;
}
