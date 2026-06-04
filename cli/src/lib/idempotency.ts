// Auto-generated Idempotency-Key per pay-link create call. The platform honors
// Idempotency-Key on POST /v1/links and returns the cached link if the SAME
// body+key arrives twice — so this dedupes a network-level retry of one create
// request. (A user re-running `links create` mints a fresh nonce → a different
// body → a new link; cross-invocation dedup isn't possible without a stable
// nonce.) The jsonl is an append-only audit trail of issued keys. Invisible to
// the user.

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureConfigDir } from "./config.js";

export function newIdempotencyKey(): string {
  return randomUUID();
}

export async function recordIdempotency(
  entry: Record<string, unknown>,
  configDir?: string,
): Promise<void> {
  const dir = await ensureConfigDir(configDir);
  const file = join(dir, "idempotency.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  await appendFile(file, line, { mode: 0o600 });
}
