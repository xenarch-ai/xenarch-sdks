import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCache, cacheToken } from "../../src/lib/token-cache.js";
import { mockCachedToken } from "../fixtures/mock-responses.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("history command logic", () => {
  it("shows empty state when no history", async () => {
    const entries = await loadCache(tmpDir);
    expect(entries).toEqual([]);
  });

  it("shows cached payments with correct fields", async () => {
    const token = mockCachedToken({
      url: "https://example.com/article/xyz",
      price_usd: "0.003",
    });
    await cacheToken(token, tmpDir);

    const entries = await loadCache(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe("https://example.com/article/xyz");
    expect(entries[0].price_usd).toBe("0.003");
    expect(entries[0].tx_hash).toBeDefined();
    expect(entries[0].paid_at).toBeDefined();
  });

  it("preserves multiple entries in insertion order", async () => {
    await cacheToken(
      mockCachedToken({ url: "https://a.com/first", gate_id: "gate_a" }),
      tmpDir,
    );
    await cacheToken(
      mockCachedToken({ url: "https://b.com/second", gate_id: "gate_b" }),
      tmpDir,
    );

    const entries = await loadCache(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe("https://a.com/first");
    expect(entries[1].url).toBe("https://b.com/second");
  });
});
