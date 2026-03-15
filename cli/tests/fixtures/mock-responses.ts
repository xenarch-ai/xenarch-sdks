import type {
  GateResponse,
  GateVerifyResponse,
  GateStatusResponse,
  CachedToken,
} from "../../src/types.js";

export function mockGateResponse(
  overrides: Partial<GateResponse> = {},
): GateResponse {
  return {
    xenarch: true,
    gate_id: "gate_7f3a0001",
    price_usd: "0.0030",
    splitter: "0x1111111111111111111111111111111111111111",
    collector: "0x2222222222222222222222222222222222222222",
    network: "base",
    asset: "USDC",
    protocol: "x402",
    verify_url: "https://xenarch.bot/v1/gates/gate_7f3a0001/verify",
    expires: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function mockVerifyResponse(
  overrides: Partial<GateVerifyResponse> = {},
): GateVerifyResponse {
  return {
    access_token: "eyJhbGciOiJIUzI1NiJ9.test-token",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function mockGateStatusResponse(
  overrides: Partial<GateStatusResponse> = {},
): GateStatusResponse {
  return {
    gate_id: "gate_7f3a0001",
    status: "pending",
    price_usd: "0.0030",
    created_at: new Date().toISOString(),
    paid_at: null,
    ...overrides,
  };
}

export function mockCachedToken(
  overrides: Partial<CachedToken> = {},
): CachedToken {
  return {
    url: "https://example.com/article/xyz",
    gate_id: "gate_7f3a0001",
    price_usd: "0.003",
    tx_hash: "0x" + "ab".repeat(32),
    access_token: "eyJhbGciOiJIUzI1NiJ9.test-token",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    paid_at: new Date().toISOString(),
    ...overrides,
  };
}

export function mock402Response(gate?: GateResponse): Response {
  const body = gate ?? mockGateResponse();
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });
}

export function mock200Response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function mock404Response(): Response {
  return new Response("Not Found", { status: 404 });
}
