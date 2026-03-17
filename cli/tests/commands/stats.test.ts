import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mock200Response,
  mock401Response,
  mock404Response,
  mockSiteStatsResponse,
} from "../fixtures/mock-responses.js";
import { getSiteStats } from "../../src/lib/api.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("stats command logic", () => {
  it("returns stats for a valid site", async () => {
    const stats = mockSiteStatsResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(stats));

    const result = await getSiteStats(
      "https://xenarch.dev",
      "xn_test_key",
      "site_001",
    );
    expect(result.total_gates).toBe(150);
    expect(result.total_paid).toBe(80);
    expect(result.revenue_usd).toBe("0.24");
    expect(result.top_pages).toHaveLength(2);
    expect(result.top_agents).toHaveLength(1);
  });

  it("includes top_pages and top_agents in stats", async () => {
    const stats = mockSiteStatsResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(stats));

    const result = await getSiteStats(
      "https://xenarch.dev",
      "xn_test_key",
      "site_001",
    );
    expect(result.top_pages[0].url).toBe("/article/one");
    expect(result.top_pages[0].count).toBe(30);
    expect(result.top_agents[0].wallet).toMatch(/^0x/);
  });

  it("sends correct URL with site ID", async () => {
    const stats = mockSiteStatsResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(stats));

    await getSiteStats("https://xenarch.dev", "xn_test_key", "site_abc123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://xenarch.dev/v1/sites/site_abc123/stats",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer xn_test_key",
        }),
      }),
    );
  });

  it("throws on invalid auth (401)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock401Response());

    await expect(
      getSiteStats("https://xenarch.dev", "bad_key", "site_001"),
    ).rejects.toThrow("Failed to get stats");
  });

  it("throws when site not found (404)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ error: "not_found", message: "Site not found", code: 404 }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      getSiteStats("https://xenarch.dev", "xn_test_key", "nonexistent"),
    ).rejects.toThrow("Failed to get stats");
  });
});
