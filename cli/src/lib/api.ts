import type {
  GateResponse,
  GateVerifyResponse,
  GateStatusResponse,
  AgentRegisterResponse,
  ApiError,
  PayJsonPricing,
  PublisherRegisterResponse,
  SiteCreateResponse,
  SiteListItem,
  SiteStatsResponse,
  PayoutUpdateResponse,
} from "../types.js";

export interface PlatformConfig {
  wc_project_id: string;
}

export async function fetchPlatformConfig(
  apiBase: string,
): Promise<PlatformConfig> {
  const res = await fetch(`${apiBase}/v1/config`, {
    headers: { "User-Agent": "xenarch-cli/0.1.0" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch platform config: ${res.statusText}`);
  }

  return (await res.json()) as PlatformConfig;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

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
    throw new Error(`Payment verification failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as GateVerifyResponse;
}

export async function getGateStatus(
  apiBase: string,
  gateId: string,
): Promise<GateStatusResponse> {
  const res = await fetch(`${apiBase}/v1/gates/${gateId}`);

  if (!res.ok) {
    throw new Error(`Failed to get gate status: ${await errorMessage(res)}`);
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
    throw new Error(`Agent registration failed: ${await errorMessage(res)}`);
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

// --- Publisher API ---

export async function registerPublisher(
  apiBase: string,
  email: string,
  password: string,
): Promise<PublisherRegisterResponse> {
  const res = await fetch(`${apiBase}/v1/publishers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(`Registration failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as PublisherRegisterResponse;
}

export async function createSite(
  apiBase: string,
  authToken: string,
  domain: string,
): Promise<SiteCreateResponse> {
  const res = await fetch(`${apiBase}/v1/sites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ domain }),
  });

  if (!res.ok) {
    throw new Error(`Failed to add site: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteCreateResponse;
}

export async function listSites(
  apiBase: string,
  authToken: string,
): Promise<SiteListItem[]> {
  const res = await fetch(`${apiBase}/v1/sites`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list sites: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteListItem[];
}

export async function getSiteStats(
  apiBase: string,
  authToken: string,
  siteId: string,
): Promise<SiteStatsResponse> {
  const res = await fetch(`${apiBase}/v1/sites/${siteId}/stats`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to get stats: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteStatsResponse;
}

export async function loginPublisher(
  apiBase: string,
  email: string,
  password: string,
): Promise<{ api_key: string }> {
  const res = await fetch(`${apiBase}/v1/publishers/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }

  return (await res.json()) as { api_key: string };
}

export async function updatePayout(
  apiBase: string,
  authToken: string,
  wallet: string,
  password: string,
  network: string = "base",
): Promise<PayoutUpdateResponse> {
  const res = await fetch(`${apiBase}/v1/publishers/me/payout`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      "X-Confirm-Password": password,
    },
    body: JSON.stringify({ wallet, network }),
  });

  if (!res.ok) {
    throw new Error(`Failed to update payout: ${await errorMessage(res)}`);
  }

  return (await res.json()) as PayoutUpdateResponse;
}
