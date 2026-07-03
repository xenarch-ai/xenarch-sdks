import { describe, it, expect, vi, afterEach } from "vitest";
import { microUsd, confirmMutation, usd } from "../../src/lib/cmd-common.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("microUsd — integer micro-USDC → trimmed dollar string", () => {
  it.each([
    [0, "$0"],
    [1, "$0.000001"],
    [12345, "$0.012345"],
    [9000000, "$9"],
    [9500000, "$9.5"],
    [9120000, "$9.12"],
    [25000000, "$25"],
  ])("microUsd(%i) === %s", (micro, expected) => {
    expect(microUsd(micro)).toBe(expected);
  });
});

describe("usd — decimal string passthrough", () => {
  it("prefixes a dollar sign", () => {
    expect(usd("9.50")).toBe("$9.50");
  });
  it("renders a dash for null/undefined", () => {
    // dim() wraps the dash in ANSI; assert the dash is present rather than exact bytes.
    expect(usd(null)).toContain("—");
    expect(usd(undefined)).toContain("—");
  });
});

describe("confirmMutation — mutation gate", () => {
  it("returns true immediately when --confirm is set (no prompt)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await confirmMutation(false, "Do it?", "do_it", { confirm: true });
    expect(ok).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("in --json mode without --confirm: emits needs_confirmation, exits 1, returns false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await confirmMutation(true, "Cancel sub_1?", "cancel_subscription", {});
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      needs_confirmation: true,
      action: "cancel_subscription",
    });
    expect(payload.message).toContain("--confirm");
  });
});
