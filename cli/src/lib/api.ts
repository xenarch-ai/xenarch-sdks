import type {
  GateResponse,
  GateVerifyResponse,
  GateStatusResponse,
  AgentRegisterResponse,
  ApiError,
  PayJsonPricing,
} from "../types.js";

export interface FetchGateResult {
  gated: boolean;
  gate: GateResponse | null;
}

export async function fetchGate(url: string): Promise<FetchGateResult> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "xenarch-cli/0.1.0",
    },
  });

  if (res.status !== 402) {
    return { gated: false, gate: null };
  }

  const body = await res.json();
  if (!body.xenarch) {
    return { gated: false, gate: null };
  }

  return { gated: true, gate: body as GateResponse };
}

export async function verifyPayment(
  verifyUrl: string,
  txHash: string,
): Promise<GateVerifyResponse> {
  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_hash: txHash }),
  });

  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    throw new Error(`Payment verification failed: ${err.message} (${err.error})`);
  }

  return (await res.json()) as GateVerifyResponse;
}

export async function getGateStatus(
  apiBase: string,
  gateId: string,
): Promise<GateStatusResponse> {
  const res = await fetch(`${apiBase}/v1/gates/${gateId}`);

  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    throw new Error(`Failed to get gate status: ${err.message}`);
  }

  return (await res.json()) as GateStatusResponse;
}

export async function registerAgent(
  apiBase: string,
  walletAddress: string,
  name?: string,
): Promise<AgentRegisterResponse> {
  const body: Record<string, string> = { wallet_address: walletAddress };
  if (name) body.name = name;

  const res = await fetch(`${apiBase}/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    throw new Error(`Agent registration failed: ${err.message}`);
  }

  return (await res.json()) as AgentRegisterResponse;
}

export async function fetchPayJson(
  originUrl: string,
): Promise<PayJsonPricing | null> {
  try {
    const origin = new URL(originUrl).origin;
    const res = await fetch(`${origin}/.well-known/pay.json`, {
      headers: { "User-Agent": "xenarch-cli/0.1.0" },
    });

    if (!res.ok) return null;
    return (await res.json()) as PayJsonPricing;
  } catch {
    return null;
  }
}
