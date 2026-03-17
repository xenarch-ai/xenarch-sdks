import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchGate, verifyPayment, getGateStatus, fetchPayJson } from "../../src/lib/api.js";
import {
  mock402Response,
  mock200Response,
  mock404Response,
  mockGateResponse,
  mockVerifyResponse,
  mockGateStatusResponse,
} from "../fixtures/mock-responses.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchGate", () => {
  it("detects a Xenarch 402 gate", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock402Response());

    const result = await fetchGate("https://example.com/article");
    expect(result.gated).toBe(true);
    expect(result.gate?.gate_id).toBe("gate_7f3a0001");
    expect(result.gate?.price_usd).toBe("0.0030");
  });

  it("returns not gated for 200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ content: "hello" }),
    );

    const result = await fetchGate("https://example.com/free");
    expect(result.gated).toBe(false);
    expect(result.gate).toBeNull();
  });

  it("returns not gated for non-Xenarch 402", async () => {
    const body = { error: "payment_required", xenarch: false };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 402 }),
    );

    const result = await fetchGate("https://other.com/page");
    expect(result.gated).toBe(false);
  });
});

describe("verifyPayment", () => {
  it("returns access token on success", async () => {
    const verifyResp = mockVerifyResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(verifyResp));

    const result = await verifyPayment(
      "https://xenarch.dev/v1/gates/gate_1/verify",
      "0x" + "ab".repeat(32),
    );
    expect(result.access_token).toBe(verifyResp.access_token);
  });

  it("throws on verification failure", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "insufficient_payment",
          message: "Transaction amount below gate price",
          code: 402,
        }),
        { status: 402 },
      ),
    );

    await expect(
      verifyPayment("https://xenarch.dev/v1/gates/gate_1/verify", "0x" + "00".repeat(32)),
    ).rejects.toThrow("Payment verification failed");
  });
});

describe("getGateStatus", () => {
  it("returns gate status", async () => {
    const statusResp = mockGateStatusResponse({ status: "paid" });
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(statusResp));

    const result = await getGateStatus("https://xenarch.dev", "gate_1");
    expect(result.status).toBe("paid");
  });
});

describe("fetchPayJson", () => {
  it("returns pay.json pricing when found", async () => {
    const pricing = { default_price_usd: 0.003, rules: [{ path: "/premium/*", price_usd: 0.01 }] };
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(pricing));

    const result = await fetchPayJson("https://example.com/article");
    expect(result?.default_price_usd).toBe(0.003);
    expect(result?.rules).toHaveLength(1);
  });

  it("returns null when pay.json not found", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock404Response());

    const result = await fetchPayJson("https://example.com/article");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));

    const result = await fetchPayJson("https://example.com/article");
    expect(result).toBeNull();
  });
});
