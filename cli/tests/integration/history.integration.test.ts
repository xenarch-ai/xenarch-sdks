import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheToken, loadCache, getValidToken } from "../../src/lib/token-cache.js";
import type { CachedToken } from "../../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-history-integ-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeToken(overrides: Partial<CachedToken> = {}): CachedToken {
  return {
    url: "https://example.com/article/1",
    gate_id: "gate_test_001",
    price_usd: "0.003",
    tx_hash: "0x" + "ab".repeat(32),
    access_token: "eyJhbGciOiJIUzI1NiJ9.test-token",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    paid_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("history from real cache files", () => {
  it("reads entries from a pre-populated cache", async () => {
    const token1 = makeToken({ url: "https://example.com/page1", gate_id: "gate_001" });
    const token2 = makeToken({ url: "https://example.com/page2", gate_id: "gate_002" });

    await cacheToken(token1, tmpDir);
    await cacheToken(token2, tmpDir);

    const entries = await loadCache(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe("https://example.com/page1");
    expect(entries[1].url).toBe("https://example.com/page2");
  });

  it("returns empty array for empty/missing cache", async () => {
    const entries = await loadCache(tmpDir);
    expect(entries).toEqual([]);
  });

  it("preserves all token fields through write/read cycle", async () => {
    const token = makeToken({
      url: "https://example.com/specific",
      gate_id: "gate_specific_123",
      price_usd: "0.0050",
      tx_hash: "0x" + "cd".repeat(32),
      access_token: "specific-token-value",
    });

    await cacheToken(token, tmpDir);
    const entries = await loadCache(tmpDir);

    expect(entries[0].url).toBe(token.url);
    expect(entries[0].gate_id).toBe(token.gate_id);
    expect(entries[0].price_usd).toBe(token.price_usd);
    expect(entries[0].tx_hash).toBe(token.tx_hash);
    expect(entries[0].access_token).toBe(token.access_token);
    expect(entries[0].expires_at).toBe(token.expires_at);
    expect(entries[0].paid_at).toBe(token.paid_at);
  });
});

describe("getValidToken against real cache files", () => {
  it("finds valid token by URL from real cache data", async () => {
    const token = makeToken({
      url: "https://example.com/target",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await cacheToken(token, tmpDir);

    const entries = await loadCache(tmpDir);
    const result = getValidToken(entries, "https://example.com/target");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/target");
    expect(result!.access_token).toBe(token.access_token);
  });

  it("returns null for expired token from real cache data", async () => {
    const token = makeToken({
      url: "https://example.com/expired-target",
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await cacheToken(token, tmpDir);

    const entries = await loadCache(tmpDir);
    const result = getValidToken(entries, "https://example.com/expired-target");
    expect(result).toBeNull();
  });

  it("returns most recent valid token when multiple exist in real cache", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await cacheToken(makeToken({ url: "https://example.com/multi", access_token: "old-token", expires_at: future }), tmpDir);
    await cacheToken(makeToken({ url: "https://example.com/multi", access_token: "new-token", expires_at: future }), tmpDir);

    const entries = await loadCache(tmpDir);
    const result = getValidToken(entries, "https://example.com/multi");
    expect(result!.access_token).toBe("new-token");
  });
});

describe("valid/expired status based on real timestamps", () => {
  it("identifies valid token (future expiry)", async () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const token = makeToken({ expires_at: futureExpiry });

    await cacheToken(token, tmpDir);
    const entries = await loadCache(tmpDir);

    const now = new Date();
    const isValid = new Date(entries[0].expires_at) > now;
    expect(isValid).toBe(true);
  });

  it("identifies expired token (past expiry)", async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const token = makeToken({ expires_at: pastExpiry });

    await cacheToken(token, tmpDir);
    const entries = await loadCache(tmpDir);

    const now = new Date();
    const isValid = new Date(entries[0].expires_at) > now;
    expect(isValid).toBe(false);
  });

  it("handles mix of valid and expired entries", async () => {
    const valid = makeToken({
      url: "https://example.com/valid",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const expired = makeToken({
      url: "https://example.com/expired",
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    await cacheToken(valid, tmpDir);
    await cacheToken(expired, tmpDir);

    const entries = await loadCache(tmpDir);
    const now = new Date();

    const validEntries = entries.filter((e) => new Date(e.expires_at) > now);
    const expiredEntries = entries.filter((e) => new Date(e.expires_at) <= now);

    expect(validEntries).toHaveLength(1);
    expect(validEntries[0].url).toBe("https://example.com/valid");
    expect(expiredEntries).toHaveLength(1);
    expect(expiredEntries[0].url).toBe("https://example.com/expired");
  });
});

describe("cache file permissions", () => {
  it("cache file has 0600 permissions", async () => {
    const token = makeToken();
    await cacheToken(token, tmpDir);

    const cachePath = join(tmpDir, "token-cache.json");
    const s = await stat(cachePath);
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("history command end-to-end", () => {
  // These tests use vi.mock to redirect the history command's loadCache to tmpDir
  it("shows payment entries from real cache", async () => {
    const token = makeToken({
      url: "https://example.com/paid-article",
      price_usd: "0.005",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await cacheToken(token, tmpDir);

    // Dynamically import with mock to redirect loadCache
    vi.doMock("../../src/lib/token-cache.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/lib/token-cache.js")>();
      return { ...actual, loadCache: () => actual.loadCache(tmpDir) };
    });

    const { createProgram } = await import("../../src/index.js");

    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "history"]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Recent payments");
    expect(output).toContain("https://example.com/paid-article");
    expect(output).toContain("$0.005");

    vi.doUnmock("../../src/lib/token-cache.js");
  });

  it("shows empty message when no cache exists", async () => {
    vi.doMock("../../src/lib/token-cache.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/lib/token-cache.js")>();
      return { ...actual, loadCache: () => actual.loadCache(tmpDir) };
    });

    const { createProgram } = await import("../../src/index.js");

    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "history"]);

    expect(console.log).toHaveBeenCalledWith("No payment history found.");

    vi.doUnmock("../../src/lib/token-cache.js");
  });

  it("outputs JSON array from real cache", async () => {
    const token = makeToken({ url: "https://example.com/json-test" });
    await cacheToken(token, tmpDir);

    vi.doMock("../../src/lib/token-cache.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/lib/token-cache.js")>();
      return { ...actual, loadCache: () => actual.loadCache(tmpDir) };
    });

    const { createProgram } = await import("../../src/index.js");

    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "--json", "history"]);

    const output = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://example.com/json-test");

    vi.doUnmock("../../src/lib/token-cache.js");
  });
});
