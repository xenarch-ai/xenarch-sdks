import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE_PATH = join(homedir(), ".xenarch", "wc-store.json");

/**
 * Delete the WC storage file entirely.
 * Called on disconnect to prevent stale session/pairing data
 * from crashing the SignClient on next connect.
 */
export async function clearWcStorage(): Promise<void> {
  try {
    await unlink(STORE_PATH);
  } catch {
    // File may not exist — that's fine
  }
}

/**
 * File-based key-value storage for WalletConnect SignClient.
 * Persists WC session data to ~/.xenarch/wc-store.json so sessions
 * survive across CLI invocations.
 */
export class FileStorage {
  private data: Record<string, unknown> = {};
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(STORE_PATH, "utf-8");
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(join(homedir(), ".xenarch"), { recursive: true, mode: 0o700 });
    await writeFile(STORE_PATH, JSON.stringify(this.data), { mode: 0o600 });
  }

  async getKeys(): Promise<string[]> {
    await this.load();
    return Object.keys(this.data);
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    await this.load();
    return Object.entries(this.data) as [string, T][];
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    await this.load();
    return this.data[key] as T | undefined;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.load();
    this.data[key] = value;
    await this.save();
  }

  async removeItem(key: string): Promise<void> {
    await this.load();
    delete this.data[key];
    await this.save();
  }
}
