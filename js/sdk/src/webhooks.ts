/**
 * Webhook signature verification for merchant backends.
 *
 * Every pay-link can POST events (payment received, subscription renewed, ...)
 * to your server. Each delivery carries an `X-Xenarch-Signature: sha256=<hex>`
 * header — HMAC-SHA256 of the raw request body keyed by the link's webhook
 * secret (the `whsec_...` value returned once at link create). Verify it
 * before trusting the payload, the same way you'd verify a Stripe or GitHub
 * webhook.
 *
 * Isomorphic: uses Web Crypto (`crypto.subtle`), so it runs on Node, Bun,
 * Deno, and edge runtimes (Cloudflare Workers, Vercel Edge).
 *
 *     import { webhooks } from "@xenarch/sdk";
 *
 *     const raw = await request.text();           // raw body, not a parsed object
 *     const sig = request.headers.get("X-Xenarch-Signature");
 *     if (!(await webhooks.verify(raw, sig, secret))) {
 *       return new Response("bad signature", { status: 401 });
 *     }
 *     const event = JSON.parse(raw);
 */
import { WebhookVerificationError } from "./errors.js";

const encoder = new TextEncoder();

/** HMAC-SHA256 of `payload` keyed by `secret`, as `sha256=<lowercase hex>`. */
export async function computeSignature(
  payload: string | Uint8Array,
  secret: string,
): Promise<string> {
  // `as unknown as BufferSource`: TS 5.7 types Uint8Array as generic over its
  // backing buffer (ArrayBufferLike), which the DOM `BufferSource` doesn't
  // accept directly. The bytes are correct at runtime.
  const body = (
    typeof payload === "string" ? encoder.encode(payload) : payload
  ) as unknown as BufferSource;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

export interface VerifyOptions {
  /** Throw `WebhookVerificationError` instead of returning `false`. */
  throwOnFailure?: boolean;
}

/**
 * Verify a webhook signature in constant time.
 *
 * @param payload the exact raw request body (do not re-serialize a parsed
 *   object — re-serialization can change bytes and break the signature).
 * @param signatureHeader the `X-Xenarch-Signature` value, e.g. `sha256=abc...`.
 * @param secret the link's `whsec_...` webhook secret.
 */
export async function verify(
  payload: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: VerifyOptions = {},
): Promise<boolean> {
  // Fail closed on a missing header — the common misuse and an attacker's
  // first move.
  if (!signatureHeader) {
    if (opts.throwOnFailure) {
      throw new WebhookVerificationError("missing webhook signature header");
    }
    return false;
  }
  const expected = await computeSignature(payload, secret);
  const ok = timingSafeEqual(expected, signatureHeader.trim());
  if (!ok && opts.throwOnFailure) {
    throw new WebhookVerificationError("webhook signature does not match");
  }
  return ok;
}

/** Length-checked constant-time string compare (no early-exit on mismatch). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const webhooks = { verify, computeSignature };
