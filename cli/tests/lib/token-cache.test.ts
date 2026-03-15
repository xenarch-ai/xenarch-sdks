import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCache,
  cacheToken,
  getValidToken,
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

describe("getValidToken", () => {
  it("returns valid cached token for matching URL", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const entries = [mockCachedToken({ url: "https://a.com/1", expires_at: future })];

    const result = getValidToken(entries, "https://a.com/1");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://a.com/1");
  });

  it("returns null for expired token", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const entries = [mockCachedToken({ url: "https://a.com/1", expires_at: past })];

    const result = getValidToken(entries, "https://a.com/1");
    expect(result).toBeNull();
  });

  it("returns null for non-matching URL", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const entries = [mockCachedToken({ url: "https://a.com/1", expires_at: future })];

    const result = getValidToken(entries, "https://b.com/2");
    expect(result).toBeNull();
  });

  it("returns most recent valid token when multiple exist", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const entries = [
      mockCachedToken({ url: "https://a.com/1", access_token: "old", expires_at: future }),
      mockCachedToken({ url: "https://a.com/1", access_token: "new", expires_at: future }),
    ];

    const result = getValidToken(entries, "https://a.com/1");
    expect(result!.access_token).toBe("new");
  });
});
