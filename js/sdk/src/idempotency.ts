/**
 * Idempotency-Key minting for link creation.
 *
 * The platform honors `Idempotency-Key` on `POST /v1/links` and returns the
 * cached link only when the *same body + key* arrives twice — so a fresh key
 * per create dedupes a network-level retry of one create request. (Re-running
 * `create` mints a fresh nonce, i.e. a different body, so it makes a new link;
 * cross-invocation dedup isn't possible without a stable nonce.) The audit log
 * is best-effort and Node-only — skipped silently on edge/browser runtimes.
 */
export function newIdempotencyKey(): string {
  return `idem_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Append a key to `~/.xenarch/idempotency.jsonl`. Best-effort; never throws. */
export async function recordIdempotency(entry: {
  key: string;
  link_id?: string;
}): Promise<void> {
  try {
    // Dynamic imports so non-Node runtimes (edge/browser) don't fail to load.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = path.join(os.homedir(), ".xenarch");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(path.join(dir, "idempotency.jsonl"), line, {
      mode: 0o600,
    });
  } catch {
    // No home dir / not Node / unwritable — auditing must not block a create.
  }
}
