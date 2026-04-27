/**
 * Local payment history cache.
 *
 * Post-XEN-179: there are no access tokens to cache — the publisher's
 * middleware re-verifies on every replay. This cache is now purely an
 * audit log of what the user has paid for, surfaced via `xenarch history`,
 * plus a way for `xenarch pay` to short-circuit when the user already
 * has a recent on-chain receipt for the same URL.
 *
 * The on-disk filename is still `token-cache.json` for backwards
 * compatibility with existing installs (the entries are pruned/replaced
 * lazily on next write).
 */

import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureConfigDir } from "./config.js";
import type { CachedPayment } from "../types.js";

const MAX_ENTRIES = 1000;

function defaultConfigDir(): string {
  return join(homedir(), ".xenarch");
}

function cachePath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "token-cache.json");
}

export async function loadCache(configDir?: string): Promise<CachedPayment[]> {
  try {
    const raw = await readFile(cachePath(configDir), "utf-8");
    return JSON.parse(raw) as CachedPayment[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function saveCache(
  entries: CachedPayment[],
  configDir?: string,
): Promise<void> {
  await ensureConfigDir(configDir);
  const p = cachePath(configDir);
  await writeFile(p, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await chmod(p, 0o600);
}

export async function cacheToken(
  entry: CachedPayment,
  configDir?: string,
): Promise<void> {
  let entries = await loadCache(configDir);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  await saveCache(entries, configDir);
}

/**
 * Most recent cached payment for `url`, or null. Used by `xenarch pay`
 * to skip re-paying a URL the user already settled — the same gate is
 * still good for replays until the publisher's verification window closes.
 */
export function getRecentPayment(
  entries: CachedPayment[],
  url: string,
): CachedPayment | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].url === url) return entries[i];
  }
  return null;
}
