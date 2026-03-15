import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateWallet,
  importWallet,
  saveWallet,
  loadWallet,
} from "../../src/lib/wallet.js";
import { readConfig, writeConfig } from "../../src/lib/config.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("wallet commands (unit)", () => {
  it("generate creates a valid wallet and saves to config", async () => {
    const w = generateWallet();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    await saveWallet(w, tmpDir);
    const config = await readConfig(tmpDir);
    expect(config.wallet?.address).toBe(w.address);
  });

  it("import with valid key saves correct address", async () => {
    const generated = generateWallet();
    const imported = importWallet(generated.privateKey);
    expect(imported.address).toBe(generated.address);

    await saveWallet(imported, tmpDir);
    const loaded = await loadWallet(tmpDir);
    expect(loaded.address).toBe(generated.address);
  });

  it("import rejects invalid keys", () => {
    expect(() => importWallet("bad")).toThrow("Invalid private key format");
    expect(() => importWallet("0xshort")).toThrow("Invalid private key format");
  });

  it("balance errors when no wallet configured", async () => {
    await writeConfig(DEFAULT_CONFIG, tmpDir);
    await expect(loadWallet(tmpDir)).rejects.toThrow("No wallet configured");
  });
});
