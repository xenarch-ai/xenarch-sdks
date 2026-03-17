import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mock201Response,
  mock409Response,
  mock401Response,
  mockSiteCreateResponse,
} from "../fixtures/mock-responses.js";
import { createSite } from "../../src/lib/api.js";

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

describe("site add command logic", () => {
  it("creates a site and returns site_token", async () => {
    const mockResp = mockSiteCreateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock201Response(mockResp));

    const result = await createSite(
      "https://xenarch.bot",
      "xn_test_key",
      "myblog.com",
    );
    expect(result.id).toBe(mockResp.id);
    expect(result.site_token).toBe(mockResp.site_token);
  });

  it("sends Authorization header with auth token", async () => {
    const mockResp = mockSiteCreateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock201Response(mockResp));

    await createSite("https://xenarch.bot", "xn_test_key", "myblog.com");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://xenarch.bot/v1/sites",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xn_test_key",
        }),
        body: JSON.stringify({ domain: "myblog.com" }),
      }),
    );
  });

  it("throws on duplicate domain (409)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock409Response("Domain already registered"),
    );

    await expect(
      createSite("https://xenarch.bot", "xn_test_key", "existing.com"),
    ).rejects.toThrow("Failed to add site");
  });

  it("throws on invalid auth (401)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock401Response());

    await expect(
      createSite("https://xenarch.bot", "bad_key", "myblog.com"),
    ).rejects.toThrow("Failed to add site");
  });
});
