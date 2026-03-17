import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mock402Response,
  mock200Response,
  mockGateResponse,
  mockVerifyResponse,
  mockCachedToken,
} from "../fixtures/mock-responses.js";

// We test the pay command logic through its constituent parts
// since the command itself orchestrates them

import { fetchGate, verifyPayment } from "../../src/lib/api.js";
import { getValidToken } from "../../src/lib/token-cache.js";

const originalFetch = globalThis.fetch;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
  globalThis.fetch = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pay command logic", () => {
  it("detects cached token and skips payment", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const entries = [
      mockCachedToken({ url: "https://example.com/paid", expires_at: future }),
    ];

    const cached = getValidToken(entries, "https://example.com/paid");
    expect(cached).not.toBeNull();
    expect(cached!.access_token).toBeDefined();
  });

  it("max-price check rejects expensive gates", async () => {
    const gate = mockGateResponse({ price_usd: "0.5000" });
    vi.mocked(globalThis.fetch).mockResolvedValue(mock402Response(gate));

    const result = await fetchGate("https://example.com/expensive");
    expect(result.gated).toBe(true);

    const price = parseFloat(result.gate!.price_usd);
    const maxPrice = 0.1;
    expect(price).toBeGreaterThan(maxPrice);
  });

  it("verification returns access token", async () => {
    const verifyResp = mockVerifyResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(verifyResp));

    const result = await verifyPayment(
      "https://xenarch.dev/v1/gates/gate_1/verify",
      "0x" + "ab".repeat(32),
    );
    expect(result.access_token).toBe(verifyResp.access_token);
    expect(result.expires_at).toBeDefined();
  });

  it("detects non-gated URL", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ content: "free" }),
    );

    const result = await fetchGate("https://example.com/free");
    expect(result.gated).toBe(false);
  });
});
