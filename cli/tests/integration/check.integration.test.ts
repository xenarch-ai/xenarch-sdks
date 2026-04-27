import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createProgram } from "../../src/index.js";
import { TestServer } from "./test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = new TestServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check command (real HTTP)", () => {
  it("detects a gated URL and shows gate info", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", `${server.baseUrl}/gated`]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Gate detected");
    expect(output).toContain("gate_test_001");
    expect(output).toContain("0.0030");
    expect(output).toContain("0x3333333333333333333333333333333333333333");
  });

  it("reports non-gated URL", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", `${server.baseUrl}/free`]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No Xenarch gate detected"),
    );
  });

  it("outputs valid JSON with --json flag", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "--json", "check", `${server.baseUrl}/gated`,
    ]);

    const output = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.gated).toBe(true);
    expect(parsed.gate.gate_id).toBe("gate_test_001");
    expect(parsed.gate.price_usd).toBe("0.0030");
    expect(parsed.gate.verify_url).toContain(server.baseUrl);
    expect(parsed.pay_json).not.toBeNull();
    expect(parsed.pay_json.default_price_usd).toBe(0.003);
  });

  it("discovers pay.json alongside gate detection", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", `${server.baseUrl}/gated`]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("pay.json found");
    expect(output).toContain("Default price:");
  });

  it("handles non-Xenarch 402 as not gated", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", `${server.baseUrl}/non-xenarch-402`]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No Xenarch gate detected"),
    );
  });

  it("JSON output for non-gated URL", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node", "xenarch", "--json", "check", `${server.baseUrl}/free`,
    ]);

    const output = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.gated).toBe(false);
    expect(parsed.gate).toBeNull();
  });
});
