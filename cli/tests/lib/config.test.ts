import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureConfigDir, readConfig, writeConfig } from "../../src/lib/config.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ensureConfigDir", () => {
  it("creates the config directory", async () => {
    const dir = join(tmpDir, "config");
    await ensureConfigDir(dir);
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    const dir = join(tmpDir, "config");
    await ensureConfigDir(dir);
    await ensureConfigDir(dir);
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });
});

describe("readConfig", () => {
  it("returns default config when file does not exist", async () => {
    const config = await readConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("reads existing config and merges with defaults", async () => {
    const dir = await ensureConfigDir(tmpDir);
    const filePath = join(dir, "config.json");
    const partial = { wallet: { address: "0xabc", private_key: "0xdef" } };
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(filePath, JSON.stringify(partial));

    const config = await readConfig(tmpDir);
    expect(config.wallet?.address).toBe("0xabc");
    expect(config.api_base).toBe(DEFAULT_CONFIG.api_base);
    expect(config.rpc_url).toBe(DEFAULT_CONFIG.rpc_url);
  });
});

describe("writeConfig", () => {
  it("writes config file with correct content", async () => {
    const config = { ...DEFAULT_CONFIG, api_base: "https://test.xenarch.dev" };
    await writeConfig(config, tmpDir);

    const filePath = join(tmpDir, "config.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.api_base).toBe("https://test.xenarch.dev");
  });

  it("sets restrictive file permissions", async () => {
    await writeConfig(DEFAULT_CONFIG, tmpDir);
    const filePath = join(tmpDir, "config.json");
    const s = await stat(filePath);
    // 0o600 = owner read/write only
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
