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
  selectAccept,
  NoFacilitatorSettledError,
} from "../../src/lib/payment.js";
import { Router } from "../../src/lib/router.js";
import { mockGateResponse, TEST_SELLER } from "../fixtures/mock-responses.js";
import { USDC_BASE, type GateResponse } from "../../src/types.js";

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
