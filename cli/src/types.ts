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
}

export const DEFAULT_CONFIG: Config = {
  wallet: null,
  api_base: "https://api.xenarch.dev",
  rpc_url: "https://mainnet.base.org",
  network: "base",
  auth_token: null,
  wc_project_id: null,
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

export interface PayoutUpdateResponse {
  confirmed: boolean;
  effective_at: string;
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
