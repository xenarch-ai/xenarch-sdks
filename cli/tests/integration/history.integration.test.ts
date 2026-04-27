import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheToken, loadCache, getRecentPayment } from "../../src/lib/token-cache.js";
import type { CachedPayment } from "../../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-history-integ-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeToken(overrides: Partial<CachedPayment> = {}): CachedPayment {
  return {
    url: "https://example.com/article/1",
    gate_id: "gate_test_001",
    price_usd: "0.003",
    tx_hash: "0x" + "ab".repeat(32),
    facilitator: "https://facilitator.payai.network",
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

  it("preserves all fields through write/read cycle", async () => {
    const token = makeToken({
      url: "https://example.com/specific",
      gate_id: "gate_specific_123",
      price_usd: "0.0050",
      tx_hash: "0x" + "cd".repeat(32),
      facilitator: "https://facilitator.xpay.dev",
    });

    await cacheToken(token, tmpDir);
    const entries = await loadCache(tmpDir);

    expect(entries[0].url).toBe(token.url);
    expect(entries[0].gate_id).toBe(token.gate_id);
    expect(entries[0].price_usd).toBe(token.price_usd);
    expect(entries[0].tx_hash).toBe(token.tx_hash);
    expect(entries[0].facilitator).toBe(token.facilitator);
    expect(entries[0].paid_at).toBe(token.paid_at);
  });
});

describe("getRecentPayment against real cache files", () => {
  it("finds payment by URL from real cache data", async () => {
    const token = makeToken({ url: "https://example.com/target" });
    await cacheToken(token, tmpDir);

    const entries = await loadCache(tmpDir);
    const result = getRecentPayment(entries, "https://example.com/target");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/target");
    expect(result!.tx_hash).toBe(token.tx_hash);
  });

  it("returns null when URL is absent", async () => {
    const token = makeToken({ url: "https://example.com/absent-key" });
    await cacheToken(token, tmpDir);

    const entries = await loadCache(tmpDir);
    const result = getRecentPayment(entries, "https://example.com/other");
    expect(result).toBeNull();
  });

  it("returns most recent entry when multiple exist for same URL", async () => {
    await cacheToken(
      makeToken({ url: "https://example.com/multi", tx_hash: "0x" + "11".repeat(32) }),
      tmpDir,
    );
    await cacheToken(
      makeToken({ url: "https://example.com/multi", tx_hash: "0x" + "22".repeat(32) }),
      tmpDir,
    );

    const entries = await loadCache(tmpDir);
    const result = getRecentPayment(entries, "https://example.com/multi");
    expect(result!.tx_hash).toBe("0x" + "22".repeat(32));
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
  it("shows payment entries from real cache", async () => {
    const token = makeToken({
      url: "https://example.com/paid-article",
      price_usd: "0.005",
    });
    await cacheToken(token, tmpDir);

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
