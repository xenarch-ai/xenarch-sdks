import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mock200Response,
  mock401Response,
  mockSiteListItem,
} from "../fixtures/mock-responses.js";
import { listSites } from "../../src/lib/api.js";

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

describe("sites command logic", () => {
  it("lists sites for authenticated publisher", async () => {
    const sites = [
      mockSiteListItem({ domain: "blog.com" }),
      mockSiteListItem({ id: "site_002", domain: "docs.io" }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(sites));

    const result = await listSites("https://xenarch.dev", "xn_test_key");
    expect(result).toHaveLength(2);
    expect(result[0].domain).toBe("blog.com");
    expect(result[1].domain).toBe("docs.io");
  });

  it("returns empty array when no sites", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response([]));

    const result = await listSites("https://xenarch.dev", "xn_test_key");
    expect(result).toEqual([]);
  });

  it("sends Authorization header", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response([]));

    await listSites("https://xenarch.dev", "xn_test_key");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://xenarch.dev/v1/sites",
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
      listSites("https://xenarch.dev", "bad_key"),
    ).rejects.toThrow("Failed to list sites");
  });
});
