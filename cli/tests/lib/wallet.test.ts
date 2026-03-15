import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateWallet,
  importWallet,
  saveWallet,
  loadWallet,
  getWalletConfig,
} from "../../src/lib/wallet.js";
import { writeConfig } from "../../src/lib/config.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generateWallet", () => {
  it("returns a valid address and private key", () => {
    const w = generateWallet();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("generates unique wallets each time", () => {
    const w1 = generateWallet();
    const w2 = generateWallet();
    expect(w1.address).not.toBe(w2.address);
  });
});

describe("importWallet", () => {
  it("derives correct address from private key", () => {
    const generated = generateWallet();
    const imported = importWallet(generated.privateKey);
    expect(imported.address).toBe(generated.address);
  });

  it("rejects invalid private key format", () => {
    expect(() => importWallet("not-a-key")).toThrow("Invalid private key format");
    expect(() => importWallet("0x123")).toThrow("Invalid private key format");
  });
});

describe("saveWallet / loadWallet", () => {
  it("round-trips wallet through config", async () => {
    const w = generateWallet();
    await saveWallet(w, tmpDir);

    const loaded = await loadWallet(tmpDir);
    expect(loaded.address).toBe(w.address);
  });

  it("throws when no wallet configured", async () => {
    await writeConfig(DEFAULT_CONFIG, tmpDir);
    await expect(loadWallet(tmpDir)).rejects.toThrow("No wallet configured");
  });
});

describe("getWalletConfig", () => {
  it("returns null when no wallet", async () => {
    await writeConfig(DEFAULT_CONFIG, tmpDir);
    const result = await getWalletConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns wallet config when set", async () => {
    const w = generateWallet();
    await saveWallet(w, tmpDir);
    const result = await getWalletConfig(tmpDir);
    expect(result?.address).toBe(w.address);
  });
});
