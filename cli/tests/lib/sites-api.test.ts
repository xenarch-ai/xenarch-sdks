import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMeSite,
  deleteMeSite,
  putSiteGating,
  putSitePricing,
  rotateSiteToken,
  getSiteTransactions,
  getSiteCategoryBreakdown,
  getPublisherGating,
  putPublisherGating,
  createSiteClaim,
  getBotCatalog,
  getBotActivity,
} from "../../src/lib/api.js";
import { SESSION_COOKIE_NAME } from "../../src/types.js";
import { mock200Response } from "../fixtures/mock-responses.js";

const API = "https://api.test";
const TOKEN = "sess_abc";
const SID = "site_1";
const originalFetch = globalThis.fetch;

function callArgs(n = 0): { url: string; init: RequestInit } {
  const call = vi.mocked(globalThis.fetch).mock.calls[n];
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}
function headerVal(init: RequestInit, name: string): string | undefined {
  return ((init.headers ?? {}) as Record<string, string>)[name];
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("sites & gating wrappers — path/verb/body/auth (XEN-518)", () => {
  it("getMeSite → GET /v1/me/sites/{id} with the SIWE cookie", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: SID }));
    await getMeSite(API, TOKEN, SID);
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/me/sites/${SID}`);
    expect(init.method ?? "GET").toBe("GET");
    expect(headerVal(init, "Cookie")).toBe(`${SESSION_COOKIE_NAME}=${TOKEN}`);
  });

  it("deleteMeSite → DELETE /v1/me/sites/{id}, resolves on 204 (no body)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const r = await deleteMeSite(API, TOKEN, SID);
    expect(callArgs().url).toBe(`${API}/v1/me/sites/${SID}`);
    expect(callArgs().init.method).toBe("DELETE");
    expect(r).toBeUndefined();
  });

  it("putSiteGating → PUT .../gating with the full body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ gating_enabled: true, gated_categories: {}, use_publisher_defaults: false }),
    );
    const body = { gating_enabled: true, gated_categories: { "AI Agents": true }, use_publisher_defaults: false };
    await putSiteGating(API, TOKEN, SID, body);
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/me/sites/${SID}/gating`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("putSitePricing → PUT .../pricing with the full body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ rules_applied: 2 }));
    const body = {
      default_price_usd: "0.01",
      default_billing_scope: "page" as const,
      rules: [{ path: "/x", price_usd: "0.02", billing_scope: "page" as const }],
    };
    const r = await putSitePricing(API, TOKEN, SID, body);
    expect(callArgs().url).toBe(`${API}/v1/me/sites/${SID}/pricing`);
    expect(callArgs().init.method).toBe("PUT");
    expect(JSON.parse(callArgs().init.body as string)).toEqual(body);
    expect(r.rules_applied).toBe(2);
  });

  it("rotateSiteToken → POST .../rotate-token", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ site_token: "st_new" }));
    const r = await rotateSiteToken(API, TOKEN, SID);
    expect(callArgs().url).toBe(`${API}/v1/me/sites/${SID}/rotate-token`);
    expect(callArgs().init.method).toBe("POST");
    expect(r.site_token).toBe("st_new");
  });

  it("getSiteTransactions → GET .../transactions?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ transactions: [], total: 0, page: 1, per_page: 25 }),
    );
    await getSiteTransactions(API, TOKEN, SID, "period=7d&status=paid&page=1&per_page=25");
    expect(callArgs().url).toBe(`${API}/v1/me/sites/${SID}/transactions?period=7d&status=paid&page=1&per_page=25`);
  });

  it("getSiteCategoryBreakdown → GET .../category-breakdown", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ categories: [] }));
    await getSiteCategoryBreakdown(API, TOKEN, SID);
    expect(callArgs().url).toBe(`${API}/v1/me/sites/${SID}/category-breakdown`);
  });

  it("getPublisherGating / putPublisherGating hit /v1/me/publisher/gating", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ gating_enabled: true, gated_categories: {}, bot_overrides: {}, publisher_id: "p1" }),
    );
    await getPublisherGating(API, TOKEN);
    expect(callArgs().url).toBe(`${API}/v1/me/publisher/gating`);
    expect(callArgs().init.method ?? "GET").toBe("GET");

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ gating_enabled: false, gated_categories: {}, bot_overrides: {}, publisher_id: "p1" }),
    );
    const body = { gating_enabled: false, gated_categories: { "AI Agents": true } };
    await putPublisherGating(API, TOKEN, body);
    expect(callArgs().url).toBe(`${API}/v1/me/publisher/gating`);
    expect(callArgs().init.method).toBe("PUT");
    expect(JSON.parse(callArgs().init.body as string)).toEqual(body);
  });

  it("createSiteClaim → POST /v1/me/site-claims with {domain, integration_type}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ site_id: "s1", claim_token: "ct", domain: "x.com", integration_type: "cli", expires_in: 300 }),
    );
    const body = { domain: "x.com", integration_type: "cli" as const };
    const r = await createSiteClaim(API, TOKEN, body);
    expect(callArgs().url).toBe(`${API}/v1/me/site-claims`);
    expect(callArgs().init.method).toBe("POST");
    expect(JSON.parse(callArgs().init.body as string)).toEqual(body);
    expect(r.claim_token).toBe("ct");
  });

  it("getBotActivity → GET /v1/me/publisher/bot-activity?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ activity: [], total_signatures: 0, window_days: 30 }),
    );
    await getBotActivity(API, TOKEN, "days=30&limit=100");
    expect(callArgs().url).toBe(`${API}/v1/me/publisher/bot-activity?days=30&limit=100`);
  });

  it("getBotCatalog → GET /v1/bot-catalog, public (no Cookie header)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ categories: ["AI Agents"], signatures: [], count: 0 }),
    );
    const r = await getBotCatalog(API);
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/bot-catalog`);
    expect(headerVal(init, "Cookie")).toBeUndefined();
    expect(r.categories).toContain("AI Agents");
  });
});
