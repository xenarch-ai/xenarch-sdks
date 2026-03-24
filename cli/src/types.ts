// Xenarch CLI types and contract constants

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
  api_base: "https://xenarch.dev",
  rpc_url: "https://mainnet.base.org",
  network: "base",
  auth_token: null,
  wc_project_id: null,
};

// --- API Responses ---

export interface GateResponse {
  xenarch: boolean;
  gate_id: string;
  price_usd: string;
  splitter: string;
  collector: string;
  network: string;
  asset: string;
  protocol: string;
  verify_url: string;
  expires: string;
}

export interface GateVerifyRequest {
  tx_hash: string;
}

export interface GateVerifyResponse {
  access_token: string;
  expires_at: string;
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

// --- Token Cache ---

export interface CachedToken {
  url: string;
  gate_id: string;
  price_usd: string;
  tx_hash: string;
  access_token: string;
  expires_at: string;
  paid_at: string;
}

// --- Payment ---

export interface PaymentResult {
  txHash: string;
  blockNumber: number;
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

export const SPLITTER_ABI = [
  "function split(address collector, uint256 amount) external",
  "event Split(address indexed collector, uint256 gross, uint256 fee, uint256 net)",
] as const;

export const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
] as const;
