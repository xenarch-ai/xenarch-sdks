import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchGate,
  verifyPayment,
  getGateStatus,
  fetchPayJson,
  claimLinkPayment,
  ClaimAwaitingConfirmationsError,
} from "../../src/lib/api.js";
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

  it("returns not gated (no vanilla) for a non-Xenarch 402 with no accepts", async () => {
    const body = { error: "payment_required", xenarch: false };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 402 }),
    );

    const result = await fetchGate("https://other.com/page");
    expect(result.gated).toBe(false);
    expect(result.vanilla).toBeNull();
  });

  it("returns a vanilla gate for a non-Xenarch 402 with accepts[] (XEN-359)", async () => {
    const body = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "3000",
          resource: "https://other.com/page",
          payTo: "0x" + "11".repeat(20),
          maxTimeoutSeconds: 60,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      ],
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 402 }),
    );

    const result = await fetchGate("https://other.com/page");
    expect(result.gated).toBe(false);
    expect(result.gate).toBeNull();
    expect(result.vanilla?.accepts).toHaveLength(1);
    expect(result.vanilla?.accepts[0].payTo).toBe("0x" + "11".repeat(20));
  });
});

describe("verifyPayment", () => {
  it("returns the verified payment record on success", async () => {
    const verifyResp = mockVerifyResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(verifyResp));

    const result = await verifyPayment(
      "https://xenarch.dev/v1/gates/gate_1/verify",
      "0x" + "ab".repeat(32),
    );
    expect(result.tx_hash).toBe(verifyResp.tx_hash);
    expect(result.status).toBe("paid");
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

describe("claimLinkPayment — 202 awaiting-confirmations (XEN-574)", () => {
  const API = "https://xenarch.dev";

  it("throws ClaimAwaitingConfirmationsError on HTTP 202 (keep polling)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "awaiting confirmations" }), {
        status: 202,
      }),
    );

    await expect(
      claimLinkPayment(API, "lnk_1", "0x" + "ab".repeat(32)),
    ).rejects.toBeInstanceOf(ClaimAwaitingConfirmationsError);
  });

  it("returns the booked claim response on HTTP 200", async () => {
    const booked = {
      attempt_id: "att_1",
      tx_hash: "0x" + "ab".repeat(32),
      status: "confirmed",
      value_usdc: "0.05",
      expected_usdc: "0.05",
      block_number: 100,
      paid_and_single_use: false,
      created: true,
      manage_url: null,
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(booked));

    const res = await claimLinkPayment(API, "lnk_1", booked.tx_hash);
    expect(res.tx_hash).toBe(booked.tx_hash);
    expect(res.status).toBe("confirmed");
    expect(res.created).toBe(true);
  });

  it("throws a non-awaiting error on a terminal 4xx (fail fast)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("link is revoked", { status: 410 }),
    );

    const err = await claimLinkPayment(API, "lnk_1", "0x" + "ab".repeat(32)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ClaimAwaitingConfirmationsError);
  });
});
