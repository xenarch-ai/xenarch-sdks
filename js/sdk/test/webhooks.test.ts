import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { webhooks, verify, WebhookVerificationError } from "../src/index.js";

const NOW = 1_700_000_000;

/** Reference scheme, identical to the platform's webhook_service.py. */
function platformSignature(secret: string, body: string, ts: number): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

const SECRET = "whsec_test_0123456789abcdef";
const BODY = '{"event_type":"payment.confirmed","link_id":"pl_abc","data":{}}';

describe("webhooks.verify (timestamped scheme)", () => {
  it("accepts a valid fresh signature (parity with the platform HMAC)", async () => {
    const sig = platformSignature(SECRET, BODY, NOW);
    expect(await verify(BODY, sig, SECRET, { now: NOW })).toBe(true);
  });

  it("matches the platform signature byte-for-byte", async () => {
    expect(await webhooks.computeSignature(BODY, SECRET, NOW)).toBe(
      platformSignature(SECRET, BODY, NOW),
    );
  });

  it("rejects a wrong secret", async () => {
    const sig = platformSignature("whsec_other", BODY, NOW);
    expect(await verify(BODY, sig, SECRET, { now: NOW })).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = platformSignature(SECRET, BODY, NOW);
    expect(await verify(BODY + " ", sig, SECRET, { now: NOW })).toBe(false);
  });

  it("rejects a stale timestamp (replay)", async () => {
    const sig = platformSignature(SECRET, BODY, NOW);
    // 10 minutes later — outside the 300s default window.
    expect(await verify(BODY, sig, SECRET, { now: NOW + 600 })).toBe(false);
  });

  it("accepts within the tolerance window", async () => {
    const sig = platformSignature(SECRET, BODY, NOW);
    expect(await verify(BODY, sig, SECRET, { now: NOW + 299 })).toBe(true);
  });

  it("fails closed on a missing or malformed header", async () => {
    expect(await verify(BODY, null, SECRET, { now: NOW })).toBe(false);
    expect(await verify(BODY, undefined, SECRET, { now: NOW })).toBe(false);
    expect(await verify(BODY, "", SECRET, { now: NOW })).toBe(false);
    expect(await verify(BODY, "sha256=deadbeef", SECRET, { now: NOW })).toBe(false);
  });

  it("throws when throwOnFailure is set", async () => {
    const sig = platformSignature(SECRET, BODY, NOW);
    await expect(
      verify(BODY, sig, SECRET, { now: NOW + 600, throwOnFailure: true }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("accepts a Uint8Array payload", async () => {
    const bytes = new TextEncoder().encode(BODY);
    const sig = platformSignature(SECRET, BODY, NOW);
    expect(await verify(bytes, sig, SECRET, { now: NOW })).toBe(true);
  });
});
