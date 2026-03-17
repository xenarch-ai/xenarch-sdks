import type {
  GateResponse,
  GateVerifyResponse,
  GateStatusResponse,
  CachedToken,
  PublisherRegisterResponse,
  SiteCreateResponse,
  SiteListItem,
  SiteStatsResponse,
  PayoutUpdateResponse,
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
    verify_url: "https://xenarch.dev/v1/gates/gate_7f3a0001/verify",
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

export function mock401Response(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Invalid API key", code: 401 }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

export function mock409Response(message: string = "Already exists"): Response {
  return new Response(
    JSON.stringify({ error: "conflict", message, code: 409 }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
}

export function mockPublisherRegisterResponse(
  overrides: Partial<PublisherRegisterResponse> = {},
): PublisherRegisterResponse {
  return {
    id: "pub_00000000-0000-0000-0000-000000000001",
    api_key: "xn_test_abcdef1234567890",
    ...overrides,
  };
}

export function mockSiteCreateResponse(
  overrides: Partial<SiteCreateResponse> = {},
): SiteCreateResponse {
  return {
    id: "site_00000000-0000-0000-0000-000000000001",
    site_token: "st_test_abcdef1234567890",
    ...overrides,
  };
}

export function mockSiteListItem(
  overrides: Partial<SiteListItem> = {},
): SiteListItem {
  return {
    id: "site_00000000-0000-0000-0000-000000000001",
    domain: "example.com",
    default_price_usd: "0.003",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function mockSiteStatsResponse(
  overrides: Partial<SiteStatsResponse> = {},
): SiteStatsResponse {
  return {
    total_gates: 150,
    total_paid: 80,
    revenue_usd: "0.24",
    period: "all",
    top_pages: [
      { url: "/article/one", count: 30, revenue_usd: "0.09" },
      { url: "/article/two", count: 20, revenue_usd: "0.06" },
    ],
    top_agents: [
      { wallet: "0x" + "aa".repeat(20), count: 25, total_usd: "0.075" },
    ],
    ...overrides,
  };
}

export function mockPayoutUpdateResponse(
  overrides: Partial<PayoutUpdateResponse> = {},
): PayoutUpdateResponse {
  return {
    confirmed: true,
    effective_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function mock201Response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
