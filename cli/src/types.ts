// Xenarch CLI types and contract constants

// --- Config ---

export interface WalletConfig {
  address: string;
  private_key: string;
}

export interface Config {
  wallet: WalletConfig | null;
  api_base: string;
  rpc_url: string;
  network: string;
}

export const DEFAULT_CONFIG: Config = {
  wallet: null,
  api_base: "https://xenarch.bot",
  rpc_url: "https://mainnet.base.org",
  network: "base",
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
