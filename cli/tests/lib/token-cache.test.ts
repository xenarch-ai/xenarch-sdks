import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCache,
  cacheToken,
  getRecentPayment,
} from "../../src/lib/token-cache.js";
import { mockCachedToken } from "../fixtures/mock-responses.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadCache", () => {
  it("returns empty array when no cache file exists", async () => {
    const cache = await loadCache(tmpDir);
    expect(cache).toEqual([]);
  });
});

describe("cacheToken", () => {
  it("writes and reads back a cached token", async () => {
    const token = mockCachedToken();
    await cacheToken(token, tmpDir);

    const cache = await loadCache(tmpDir);
    expect(cache).toHaveLength(1);
    expect(cache[0].gate_id).toBe(token.gate_id);
  });

  it("appends multiple tokens", async () => {
    await cacheToken(mockCachedToken({ url: "https://a.com/1" }), tmpDir);
    await cacheToken(mockCachedToken({ url: "https://a.com/2" }), tmpDir);

    const cache = await loadCache(tmpDir);
    expect(cache).toHaveLength(2);
  });
});

describe("getRecentPayment", () => {
  it("returns most recent payment for matching URL", () => {
    const entries = [mockCachedToken({ url: "https://a.com/1" })];

    const result = getRecentPayment(entries, "https://a.com/1");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://a.com/1");
  });

  it("returns null for non-matching URL", () => {
    const entries = [mockCachedToken({ url: "https://a.com/1" })];

    const result = getRecentPayment(entries, "https://b.com/2");
    expect(result).toBeNull();
  });

  it("returns most recent entry when multiple exist for same URL", () => {
    const entries = [
      mockCachedToken({ url: "https://a.com/1", tx_hash: "0x" + "11".repeat(32) }),
      mockCachedToken({ url: "https://a.com/1", tx_hash: "0x" + "22".repeat(32) }),
    ];

    const result = getRecentPayment(entries, "https://a.com/1");
    expect(result!.tx_hash).toBe("0x" + "22".repeat(32));
  });
});
