import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgram } from "../../src/index.js";
import {
  mock402Response,
  mock200Response,
  mock404Response,
  mockGateResponse,
} from "../fixtures/mock-responses.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("check command", () => {
  it("detects a gated URL", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pay.json")) return mock404Response();
      return mock402Response(gate);
    });

    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", "https://example.com/article"]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Gate detected"),
    );
  });

  it("reports non-gated URL", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pay.json")) return mock404Response();
      return mock200Response({ content: "free" });
    });

    const program = createProgram();
    await program.parseAsync(["node", "xenarch", "check", "https://example.com/free"]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No Xenarch gate detected"),
    );
  });

  it("outputs JSON when --json flag is set", async () => {
    const gate = mockGateResponse();
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pay.json")) return mock404Response();
      return mock402Response(gate);
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "xenarch",
      "--json",
      "check",
      "https://example.com/article",
    ]);

    const output = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.gated).toBe(true);
    expect(parsed.gate.gate_id).toBe(gate.gate_id);
  });

  it("rejects invalid URLs", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(["node", "xenarch", "check", "not-a-url"]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid URL"),
    );
  });
});
