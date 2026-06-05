/**
 * Webhook signature verification for merchant + agent-operator backends.
 *
 * Every pay-link and every agent can POST events (payment.confirmed,
 * subscription.renewed, cap.exceeded, scope.denied, ...) to your server. Each
 * delivery carries a Stripe-style timestamped signature:
 *
 *     X-Xenarch-Signature: t=<unix_seconds>,v1=<hex>
 *         where v1 = HMAC_SHA256(secret, "<unix_seconds>.<raw_body>")
 *     X-Xenarch-Event:     <event_type>     e.g. payment.confirmed
 *     X-Xenarch-Delivery:  <uuid>           idempotency key for retries
 *
 * Signing the timestamp alongside the body makes a captured delivery
 * un-replayable: `verify` rejects any request whose `t` is more than
 * `toleranceSeconds` (default 300) from now. Verify before trusting the
 * payload, the same way you'd verify a Stripe webhook. The same scheme covers
 * both pay-link and agent webhooks — one `verify` call works for either.
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

/** Replay window: reject deliveries whose signed `t` is older/newer than this. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

function toBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? encoder.encode(payload) : payload;
}

/** Concatenate `"<timestamp>."` + body into the exact bytes that get signed. */
function signedBytes(timestamp: number, payload: string | Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.`);
  const body = toBytes(payload);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

async function hmacHex(message: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // `as unknown as BufferSource`: TS types Uint8Array as generic over its
  // backing buffer, which the DOM `BufferSource` doesn't accept directly.
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    message as unknown as BufferSource,
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute the full `X-Xenarch-Signature` header value for `payload` at
 * `timestamp` (unix seconds), keyed by `secret`. Returns `t=<ts>,v1=<hex>` —
 * byte-for-byte what the platform sends.
 */
export async function computeSignature(
  payload: string | Uint8Array,
  secret: string,
  timestamp: number,
): Promise<string> {
  const hex = await hmacHex(signedBytes(timestamp, payload), secret);
  return `t=${timestamp},v1=${hex}`;
}

/** Parse `t=<int>,v1=<hex>` (order-independent). Returns null if malformed. */
function parseSignatureHeader(
  header: string,
): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.trim().split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === "t") {
      const parsed = Number.parseInt(val, 10);
      if (Number.isFinite(parsed)) t = parsed;
    } else if (k === "v1") {
      v1 = val;
    }
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}

export interface VerifyOptions {
  /** Throw `WebhookVerificationError` instead of returning `false`. */
  throwOnFailure?: boolean;
  /** Replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds) — for tests. */
  now?: number;
}

/**
 * Verify a webhook signature in constant time, with replay protection.
 *
 * @param payload the exact raw request body (do not re-serialize a parsed
 *   object — re-serialization can change bytes and break the signature).
 * @param signatureHeader the `X-Xenarch-Signature` value, e.g. `t=...,v1=...`.
 * @param secret the link's or agent's `whsec_...` webhook secret.
 */
export async function verify(
  payload: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: VerifyOptions = {},
): Promise<boolean> {
  const fail = (msg: string): boolean => {
    if (opts.throwOnFailure) throw new WebhookVerificationError(msg);
    return false;
  };

  // Fail closed on a missing header — the common misuse and an attacker's
  // first move.
  if (!signatureHeader) return fail("missing webhook signature header");

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return fail("malformed webhook signature header");

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > tolerance) {
    return fail("webhook timestamp outside tolerance (replay?)");
  }

  const expected = await hmacHex(signedBytes(parsed.t, payload), secret);
  if (!timingSafeEqual(expected, parsed.v1)) {
    return fail("webhook signature does not match");
  }
  return true;
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

export const webhooks = { verify, computeSignature, DEFAULT_TOLERANCE_SECONDS };
