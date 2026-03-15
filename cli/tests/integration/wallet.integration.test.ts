import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateWallet,
  importWallet,
  saveWallet,
  loadWallet,
  getWalletConfig,
} from "../../src/lib/wallet.js";
import { ensureConfigDir } from "../../src/lib/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-wallet-integ-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("wallet generate → load → verify (real filesystem)", () => {
  it("generates, saves, and loads back the same wallet", async () => {
    const generated = generateWallet();
    await saveWallet(generated, tmpDir);

    const loaded = await loadWallet(tmpDir);
    expect(loaded.address).toBe(generated.address);
    expect(loaded.privateKey).toBe(generated.privateKey);
  });

  it("generates valid Ethereum addresses", async () => {
    const w = generateWallet();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});

describe("wallet import → load → verify (real filesystem)", () => {
  it("imports a private key and derives the correct address", async () => {
    const original = generateWallet();
    const imported = importWallet(original.privateKey);

    expect(imported.address).toBe(original.address);
    expect(imported.privateKey).toBe(original.privateKey);
  });

  it("round-trips import through save/load", async () => {
    const original = generateWallet();
    const imported = importWallet(original.privateKey);

    await saveWallet(imported, tmpDir);
    const loaded = await loadWallet(tmpDir);

    expect(loaded.address).toBe(original.address);
  });
});

describe("file permissions (real filesystem)", () => {
  it("config file has 0600 permissions", async () => {
    const w = generateWallet();
    await saveWallet(w, tmpDir);

    const configPath = join(tmpDir, "config.json");
    const s = await stat(configPath);
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("config directory has 0700 permissions", async () => {
    const dir = join(tmpDir, "subdir");
    await ensureConfigDir(dir);

    const s = await stat(dir);
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("overwrite detection (real filesystem)", () => {
  it("detects existing wallet via getWalletConfig", async () => {
    const w1 = generateWallet();
    await saveWallet(w1, tmpDir);

    const existing = await getWalletConfig(tmpDir);
    expect(existing).not.toBeNull();
    expect(existing!.address).toBe(w1.address);
  });

  it("overwrites wallet when saveWallet is called again", async () => {
    const w1 = generateWallet();
    await saveWallet(w1, tmpDir);

    const w2 = generateWallet();
    await saveWallet(w2, tmpDir);

    const loaded = await loadWallet(tmpDir);
    expect(loaded.address).toBe(w2.address);
    expect(loaded.address).not.toBe(w1.address);
  });

  it("returns null when no wallet exists", async () => {
    // Ensure config dir exists but has no wallet
    await ensureConfigDir(tmpDir);
    const existing = await getWalletConfig(tmpDir);
    expect(existing).toBeNull();
  });
});
