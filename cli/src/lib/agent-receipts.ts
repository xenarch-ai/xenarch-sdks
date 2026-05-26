// Agent control plane receipt reporting (XEN-372 — Phase 2 of XEN-370).
//
// After every settled payment, `xenarch pay` POSTs to
// /v1/agent/receipts with the user's xa_live_* token (XENARCH_API_TOKEN).
// Fire-and-forget — failures don't break the pay flow. Best-effort with
// an offline queue at ~/.xenarch/receipts-queue.jsonl so a flake doesn't
// drop receipts; the next `xenarch pay` drains it.
//
// No token → no-op. The CLI stays usable standalone (Phase-1 backwards
// compat). This module is intentionally decoupled from `pay.ts`; if the
// control plane is down or unreachable, payments themselves still go
// through.

import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_TOKEN = "XENARCH_API_TOKEN";
const QUEUE_CAP = 100;
const REPORT_TIMEOUT_MS = 5000;

export interface ReceiptPayload {
  url: string;
  amount_usd: string;
  source: "cli" | "mcp" | "sdk" | "custom";
  status: "paid" | "pending" | "failed";
  paid_at: string;
  tx_hash?: string | null;
  facilitator?: string | null;
  wallet_address?: string | null;
  // XEN-373: chain-of-custody voucher from POST /v1/agent/preflight.
  // Optional — receipts without it record with chain_verified=false
  // for Phase-2 backwards compat.
  auth_token?: string | null;
}

function queuePath(): string {
  return join(homedir(), ".xenarch", "receipts-queue.jsonl");
}

async function ensureDir(): Promise<void> {
  await mkdir(join(homedir(), ".xenarch"), { recursive: true, mode: 0o700 });
}

async function readQueue(): Promise<ReceiptPayload[]> {
  try {
    const raw = await readFile(queuePath(), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as ReceiptPayload;
        } catch {
          return null;
        }
      })
      .filter((p): p is ReceiptPayload => p !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

async function writeQueue(entries: ReceiptPayload[]): Promise<void> {
  await ensureDir();
  // Keep the most recent QUEUE_CAP entries — drop the oldest if we
  // overflow. The agent operator cares about recent activity, not a
  // backlog from a week-long outage.
  const trimmed = entries.slice(-QUEUE_CAP);
  const tmp = `${queuePath()}.tmp`;
  await writeFile(
    tmp,
    trimmed.map((e) => JSON.stringify(e)).join("\n") + (trimmed.length > 0 ? "\n" : ""),
    { mode: 0o600 },
  );
  await rename(tmp, queuePath());
}

async function appendToQueue(payload: ReceiptPayload): Promise<void> {
  await ensureDir();
  const existing = await readQueue();
  existing.push(payload);
  await writeQueue(existing);
}

/**
 * POST the receipt to the platform. Returns true on success, false on
 * any failure (network, 5xx, timeout). 4xx is treated as terminal —
 * the receipt is malformed or the token is invalid; queueing won't help.
 */
async function tryPost(
  apiBase: string,
  token: string,
  payload: ReceiptPayload,
): Promise<{ ok: boolean; terminal: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/agent/receipts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": token,
        "User-Agent": "xenarch-cli/0.3.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, terminal: true };
    if (res.status >= 400 && res.status < 500) {
      // Bad request or revoked token — never going to succeed.
      return { ok: false, terminal: true };
    }
    return { ok: false, terminal: false };
  } catch {
    return { ok: false, terminal: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the persisted queue. Stops at the first transient failure so
 * we don't burn through 100 timeouts in series during a real outage.
 * Terminal failures (4xx) get dropped.
 */
async function drainQueue(apiBase: string, token: string): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  const remaining: ReceiptPayload[] = [];
  let stopFlushing = false;
  for (const entry of queue) {
    if (stopFlushing) {
      remaining.push(entry);
      continue;
    }
    const result = await tryPost(apiBase, token, entry);
    if (result.ok) continue;
    if (result.terminal) continue; // 4xx — drop, never going to land
    remaining.push(entry);
    stopFlushing = true;
  }
  await writeQueue(remaining);
}

/**
 * Report a settled receipt to the agent control plane.
 *
 * - No `XENARCH_API_TOKEN` set → no-op (Phase-1 backwards compat).
 * - Network/5xx failures → queued for next invocation.
 * - 4xx → dropped (bad token or malformed body; no point retrying).
 *
 * Never throws — receipts are a bookkeeping side-effect; the payment
 * itself already succeeded.
 */
export async function reportReceipt(
  apiBase: string,
  payload: ReceiptPayload,
): Promise<void> {
  const token = process.env[ENV_TOKEN];
  if (!token) return;
  try {
    const result = await tryPost(apiBase, token, payload);
    if (!result.ok && !result.terminal) {
      await appendToQueue(payload);
    }
    // Drain queue best-effort whenever we have a working token. Don't
    // hold up the CLI: if the queue is long and the platform is slow,
    // the user already got their payment receipt — flushing is async.
    await drainQueue(apiBase, token);
  } catch {
    // Defensive: never let receipt reporting break the calling flow.
  }
}
