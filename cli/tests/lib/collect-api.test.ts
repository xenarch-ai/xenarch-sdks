import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectPermit,
  collectMetered,
  ClaimAwaitingConfirmationsError,
} from "../../src/lib/api.js";
import { SESSION_COOKIE_NAME } from "../../src/types.js";
import { mock200Response } from "../fixtures/mock-responses.js";

const API = "https://api.test";
const T = "sess_abc";
const originalFetch = globalThis.fetch;

function callArgs(n = 0): { url: string; init: RequestInit } {
  const call = vi.mocked(globalThis.fetch).mock.calls[n];
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("collect record wrappers (XEN-613)", () => {
  it("collectPermit → POST .../permit/collect with {tx_hash} + cookie", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", status: "confirmed", cycle: 1 }),
    );
    const r = await collectPermit(API, T, "sub_1", "0xabc");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/sub_1/permit/collect`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Cookie).toBe(`${SESSION_COOKIE_NAME}=${T}`);
    expect(JSON.parse(init.body as string)).toEqual({ tx_hash: "0xabc" });
    expect(r.cycle).toBe(1);
  });

  it("collectMetered → POST .../metered/collect with {tx_hash}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", status: "confirmed" }),
    );
    await collectMetered(API, T, "sub_1", "0xdef");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/sub_1/metered/collect`);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ tx_hash: "0xdef" });
  });

  it("throws ClaimAwaitingConfirmationsError on HTTP 202 (keep polling, do NOT treat as success)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "awaiting confirmations" }), { status: 202 }),
    );
    await expect(collectPermit(API, T, "sub_1", "0xabc")).rejects.toBeInstanceOf(
      ClaimAwaitingConfirmationsError,
    );
  });

  it("throws a normal error on a terminal 4xx (e.g. 409 not collectable)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "not collectable" }), { status: 409 }),
    );
    const err = await collectMetered(API, T, "sub_1", "0xabc").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ClaimAwaitingConfirmationsError);
    expect((err as Error).message).toContain("not collectable");
  });
});
