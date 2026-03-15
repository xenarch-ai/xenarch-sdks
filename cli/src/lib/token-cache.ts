import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureConfigDir } from "./config.js";
import type { CachedToken } from "../types.js";

const MAX_ENTRIES = 1000;

function defaultConfigDir(): string {
  return join(homedir(), ".xenarch");
}

function cachePath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "token-cache.json");
}

export async function loadCache(configDir?: string): Promise<CachedToken[]> {
  try {
    const raw = await readFile(cachePath(configDir), "utf-8");
    return JSON.parse(raw) as CachedToken[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function saveCache(
  entries: CachedToken[],
  configDir?: string,
): Promise<void> {
  await ensureConfigDir(configDir);
  const p = cachePath(configDir);
  await writeFile(p, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await chmod(p, 0o600);
}

export async function cacheToken(
  entry: CachedToken,
  configDir?: string,
): Promise<void> {
  let entries = await loadCache(configDir);
  entries.push(entry);

  // Evict if over max
  if (entries.length > MAX_ENTRIES) {
    entries = evict(entries);
  }

  await saveCache(entries, configDir);
}

export function getValidToken(
  entries: CachedToken[],
  url: string,
): CachedToken | null {
  const now = new Date();
  // Search from end (most recent first)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.url === url && new Date(e.expires_at) > now) {
      return e;
    }
  }
  return null;
}

function evict(entries: CachedToken[]): CachedToken[] {
  const now = new Date();

  // Separate expired and valid
  const expired: CachedToken[] = [];
  const valid: CachedToken[] = [];
  for (const e of entries) {
    if (new Date(e.expires_at) <= now) {
      expired.push(e);
    } else {
      valid.push(e);
    }
  }

  // If removing all expired brings us under limit, done
  if (valid.length <= MAX_ENTRIES) {
    return valid;
  }

  // Otherwise, keep the most recent MAX_ENTRIES valid entries
  return valid.slice(valid.length - MAX_ENTRIES);
}
