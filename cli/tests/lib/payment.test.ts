/**
 * Tests for the V2 (post-XEN-179) payment executor.
 *
 * Mirrors the Python `tests/test_payer_v2.py` shape: mock fetch for the
 * facilitator `/settle` endpoint, exercise happy path / fallback / all-fail,
 * verify the signed EIP-3009 payload addresses the right `to` and amount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  executePayment,
  executePaymentV1Inline,
  pickV1Accept,
  selectAccept,
  NoFacilitatorSettledError,
} from "../../src/lib/payment.js";
import { Router } from "../../src/lib/router.js";
import { mockGateResponse, TEST_SELLER } from "../fixtures/mock-responses.js";
import {
  USDC_BASE,
  type GateResponse,
  type PaymentRequirements,
} from "../../src/types.js";

const originalFetch = globalThis.fetch;

function makeSigner(): ethers.Wallet {
  // Deterministic wallet — useful when we want to inspect the signature.
  return new ethers.Wallet(
    "0x0123456789012345678901234567890123456789012345678901234567890123",
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function settleResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("selectAccept", () => {
  it("returns null when accepts is empty", () => {
    expect(selectAccept([], "base")).toBeNull();
  });

  it("prefers exact + matching network + USDC", () => {
    const a = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "3000",
      resource: "x",
      payTo: TEST_SELLER,
      maxTimeoutSeconds: 60,
      asset: "0xdead",
    };
    const b = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "3000",
      resource: "x",
      payTo: TEST_SELLER,
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
    };
    const picked = selectAccept([a, b], "base");
    expect(picked?.asset).toBe(USDC_BASE);
  });

  it("falls back to any exact entry on the requested network", () => {
    const a = {
      scheme: "exact",
      network: "solana",
      maxAmountRequired: "3000",
      resource: "x",
      payTo: TEST_SELLER,
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
    };
    const b = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "3000",
      resource: "x",
      payTo: TEST_SELLER,
      maxTimeoutSeconds: 60,
      asset: "0xdead",
    };
    const picked = selectAccept([a, b], "base");
    expect(picked?.network).toBe("base");
  });
});

describe("executePayment happy path", () => {
  it("settles via the first facilitator and returns tx hash", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      settleResponse({ success: true, transaction: "0x" + "ab".repeat(32) }),
    );

    const result = await executePayment(gate, makeSigner());

    expect(result.tx_hash).toBe("0x" + "ab".repeat(32));
    expect(result.facilitator).toBe("https://facilitator.payai.network");
    expect(result.gate_id).toBe(gate.gate_id);
    expect(result.amount_usd).toBe("0.0030");
  });

  it("POSTs to {facilitator}/settle with the signed payload", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      settleResponse({ success: true, transaction: "0x" + "cd".repeat(32) }),
    );

    await executePayment(gate, makeSigner());

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://facilitator.payai.network/settle");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.x402Version).toBe(1);
    expect(body.paymentRequirements.payTo).toBe(TEST_SELLER);
    expect(body.paymentPayload.scheme).toBe("exact");
    expect(body.paymentPayload.network).toBe("base");

    const auth = body.paymentPayload.payload.authorization;
    // `to` must be the seller wallet, NOT a splitter.
    expect(auth.to).toBe(TEST_SELLER);
    // value = parseUnits("0.0030", 6) = 3000.
    expect(auth.value).toBe("3000");
    expect(auth.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(auth.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(auth.validAfter).toBe("0");
    expect(BigInt(auth.validBefore)).toBeGreaterThan(BigInt(0));

    // Signature is a 65-byte hex string from EIP-712 signTypedData.
    expect(body.paymentPayload.payload.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

describe("executePayment fallback", () => {
  it("falls back to next facilitator when the first returns 500", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(settleResponse({ error: "internal" }, 500))
      .mockResolvedValueOnce(
        settleResponse({ success: true, transaction: "0x" + "ef".repeat(32) }),
      );

    const router = new Router(
      gate.facilitators.map((f) => ({
        name: f.name,
        url: f.url,
        specVersion: f.spec_version,
      })),
    );
    const recordFailure = vi.spyOn(router, "recordFailure");
    const recordSuccess = vi.spyOn(router, "recordSuccess");

    const result = await executePayment(gate, makeSigner(), { router });

    expect(result.tx_hash).toBe("0x" + "ef".repeat(32));
    expect(result.facilitator).toBe("https://facilitator.xpay.dev");
    expect(recordFailure).toHaveBeenCalledWith(
      "https://facilitator.payai.network",
    );
    expect(recordSuccess).toHaveBeenCalledWith(
      "https://facilitator.xpay.dev",
      expect.any(Number),
    );
  });

  it("treats success=false as failure and falls through", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        settleResponse({ success: false, errorReason: "insufficient_funds" }),
      )
      .mockResolvedValueOnce(
        settleResponse({ success: true, transaction: "0x" + "12".repeat(32) }),
      );

    const result = await executePayment(gate, makeSigner());
    expect(result.tx_hash).toBe("0x" + "12".repeat(32));
  });

  it("treats missing transaction as failure and falls through", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(settleResponse({ success: true }))
      .mockResolvedValueOnce(
        settleResponse({ success: true, transaction: "0x" + "34".repeat(32) }),
      );

    const result = await executePayment(gate, makeSigner());
    expect(result.tx_hash).toBe("0x" + "34".repeat(32));
  });
});

describe("executePayment all-fail", () => {
  it("throws NoFacilitatorSettledError with tried list", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      settleResponse({ success: false, errorReason: "x" }),
    );

    let caught: unknown;
    try {
      await executePayment(gate, makeSigner());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoFacilitatorSettledError);
    expect((caught as NoFacilitatorSettledError).tried).toEqual([
      "https://facilitator.payai.network",
      "https://facilitator.xpay.dev",
    ]);
  });

  it("throws when gate has no advertised facilitators", async () => {
    const gate: GateResponse = mockGateResponse({ facilitators: [] });
    // Empty facilitator list = Router constructor throws first; that's
    // surfaced as a clean error to the caller (matches the Python contract).
    await expect(executePayment(gate, makeSigner())).rejects.toThrow(
      /at least one facilitator/,
    );
  });

  it("throws when no compatible accepts entry", async () => {
    const gate: GateResponse = mockGateResponse({ accepts: [] });
    await expect(executePayment(gate, makeSigner())).rejects.toThrow(
      /no compatible payment scheme/,
    );
  });
});

// --- XEN-359: vanilla (non-Xenarch) x402 V1 X-PAYMENT flow -----------------

function usdcAccept(
  over: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "3000",
    resource: "https://other.com/page",
    payTo: TEST_SELLER,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE,
    ...over,
  };
}

describe("pickV1Accept", () => {
  it("selects a USDC-on-Base exact accept and computes the USD price", () => {
    const sel = pickV1Accept([usdcAccept()]);
    expect(sel.accept.payTo).toBe(TEST_SELLER);
    expect(sel.amount).toBe(3000n);
    expect(sel.priceUsd).toBe("0.003");
  });

  it("rejects a non-USDC asset", () => {
    expect(() => pickV1Accept([usdcAccept({ asset: "0xdead" })])).toThrow(
      /only pay USDC on Base/,
    );
  });

  it("rejects a non-Base network", () => {
    expect(() => pickV1Accept([usdcAccept({ network: "solana" })])).toThrow(
      /only pay USDC on Base/,
    );
  });

  it("throws when there are no payment requirements", () => {
    expect(() => pickV1Accept([])).toThrow(/no payment requirements/);
  });

  it("rejects a non-positive amount (empty maxAmountRequired → 0)", () => {
    expect(() => pickV1Accept([usdcAccept({ maxAmountRequired: "" })])).toThrow(
      /non-positive amount/,
    );
  });
});

describe("executePaymentV1Inline", () => {
  it("sends a base64 X-PAYMENT header and returns the tx from X-PAYMENT-RESPONSE", async () => {
    const txResp = Buffer.from(
      JSON.stringify({ transaction: "0x" + "ab".repeat(32) }),
    ).toString("base64");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("content", {
        status: 200,
        headers: { "X-PAYMENT-RESPONSE": txResp },
      }),
    );

    const res = await executePaymentV1Inline(
      "https://other.com/page",
      usdcAccept(),
      3000n,
      makeSigner(),
    );
    expect(res.tx_hash).toBe("0x" + "ab".repeat(32));
    expect(res.pay_to).toBe(TEST_SELLER);
    // XEN-466: the unlocked content the buyer paid for is returned, not dropped.
    expect(res.content).toBe("content");

    // The replay GET carries a base64 X-PAYMENT voucher signed to the seller.
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    const header = (init.headers as Record<string, string>)["X-PAYMENT"];
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(payload.scheme).toBe("exact");
    expect(payload.payload.authorization.to).toBe(TEST_SELLER);
    expect(payload.payload.authorization.value).toBe("3000");
    expect(payload.payload.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("returns a null tx_hash when the server omits X-PAYMENT-RESPONSE", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("content", { status: 200 }),
    );
    const res = await executePaymentV1Inline(
      "https://other.com/page",
      usdcAccept(),
      3000n,
      makeSigner(),
    );
    expect(res.tx_hash).toBeNull();
    expect(res.pay_to).toBe(TEST_SELLER);
  });

  it("throws when the resource server does not return 200", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("still gated", { status: 402 }),
    );
    await expect(
      executePaymentV1Inline(
        "https://other.com/page",
        usdcAccept(),
        3000n,
        makeSigner(),
      ),
    ).rejects.toThrow(/HTTP 402/);
  });
});
