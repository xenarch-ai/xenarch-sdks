import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { webhooks, verify, WebhookVerificationError } from "../src/index.js";

/** Reference scheme, identical to the platform's webhook_service.py. */
function platformSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const SECRET = "whsec_test_0123456789abcdef";
const BODY = '{"event_type":"payment.received","link_id":"pl_abc","data":{}}';

describe("webhooks.verify", () => {
  it("accepts a valid signature (parity with the platform HMAC)", async () => {
    const sig = platformSignature(SECRET, BODY);
    expect(await verify(BODY, sig, SECRET)).toBe(true);
  });

  it("matches the platform signature byte-for-byte", async () => {
    expect(await webhooks.computeSignature(BODY, SECRET)).toBe(
      platformSignature(SECRET, BODY),
    );
  });

  it("rejects a wrong secret", async () => {
    const sig = platformSignature("whsec_other", BODY);
    expect(await verify(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = platformSignature(SECRET, BODY);
    expect(await verify(BODY + " ", sig, SECRET)).toBe(false);
  });

  it("fails closed on a missing header", async () => {
    expect(await verify(BODY, null, SECRET)).toBe(false);
    expect(await verify(BODY, undefined, SECRET)).toBe(false);
    expect(await verify(BODY, "", SECRET)).toBe(false);
  });

  it("throws when throwOnFailure is set", async () => {
    await expect(
      verify(BODY, "sha256=deadbeef", SECRET, { throwOnFailure: true }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("accepts a Uint8Array payload", async () => {
    const bytes = new TextEncoder().encode(BODY);
    const sig = platformSignature(SECRET, BODY);
    expect(await verify(bytes, sig, SECRET)).toBe(true);
  });
});
