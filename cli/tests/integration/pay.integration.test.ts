import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TestServer } from "./test-server.js";

// tmpDir is reassigned each test — mocks close over the variable reference
let tmpDir: string;

// Mock payment execution (needs real EVM node) but keep HTTP real
vi.mock("../../src/lib/payment.js", () => ({
  executePayment: vi.fn().mockResolvedValue({
    txHash: "0x" + "ff".repeat(32),
    blockNumber: 12345,
  }),
}));

// Redirect filesystem operations to temp dir
vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/config.js")>();
  return {
    ...actual,
    readConfig: () => actual.readConfig(tmpDir),
    writeConfig: (config: import("../../src/types.js").Config) => actual.writeConfig(config, tmpDir),
    ensureConfigDir: () => actual.ensureConfigDir(tmpDir),
  };
});

vi.mock("../../src/lib/token-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/token-cache.js")>();
  return {
    ...actual,
    loadCache: () => actual.loadCache(tmpDir),
    cacheToken: (entry: import("../../src/types.js").CachedPayment) => actual.cacheToken(entry, tmpDir),
  };
});

vi.mock("../../src/lib/wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/wallet.js")>();
  return {
    ...actual,
    loadWallet: () => actual.loadWallet(tmpDir),
    saveWallet: (w: import("../../src/lib/wallet.js").GeneratedWallet) => actual.saveWallet(w, tmpDir),
    getWalletConfig: () => actual.getWalletConfig(tmpDir),
  };
});

// Import after mocks are declared (Vitest hoists vi.mock but imports must follow)
const { createProgram } = await import("../../src/index.js");
const { generateWallet, saveWallet } = await import("../../src/lib/wallet.js");

let server: TestServer;

beforeAll(async () => {
  server = new TestServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-pay-test-"));
  const wallet = generateWallet();
  await saveWallet(wallet);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("pay command --dry-run (real HTTP)", () => {
  it("shows gate info from real 402 without sending transaction", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "pay", "--dry-run", `${server.baseUrl}/gated`,
    ]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("[DRY RUN]");
    expect(output).toContain("0.0030");
    expect(output).toContain("gate_test_001");
    expect(output).toContain("No transaction sent");
  });

  it("dry-run JSON output includes real gate data", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "--json", "pay", "--dry-run", `${server.baseUrl}/gated`,
    ]);

    const output = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.gate.gate_id).toBe("gate_test_001");
    expect(parsed.gate.price_usd).toBe("0.0030");
    expect(parsed.gate.verify_url).toContain(server.baseUrl);
  });
});

describe("pay command --max-price (real HTTP)", () => {
  it("rejects when real price exceeds max", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "pay", "--dry-run", "--max-price", "0.001",
      `${server.baseUrl}/gated`,
    ]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("exceeds max price"),
    );
  });

  it("allows when real price is within max", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "pay", "--dry-run", "--max-price", "1.00",
      `${server.baseUrl}/gated`,
    ]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("[DRY RUN]");
  });
});

describe("pay command with expired gate (real HTTP)", () => {
  it("rejects expired gate from server", async () => {
    const expiredServer = new TestServer({
      gateExpires: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await expiredServer.start();

    try {
      const program = createProgram();
      await program.parseAsync([
        "node", "xenarch", "pay", `${expiredServer.baseUrl}/gated`,
      ]);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Gate has expired"),
      );
    } finally {
      await expiredServer.stop();
    }
  });
});

describe("pay command with non-gated URL (real HTTP)", () => {
  it("reports URL is not gated", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "pay", `${server.baseUrl}/free`,
    ]);

    expect(console.log).toHaveBeenCalledWith("This URL is not gated by Xenarch.");
  });
});
