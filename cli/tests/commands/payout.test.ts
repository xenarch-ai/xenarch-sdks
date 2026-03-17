import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mock200Response,
  mock401Response,
  mockPayoutUpdateResponse,
} from "../fixtures/mock-responses.js";
import { updatePayout } from "../../src/lib/api.js";

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

describe("payout set command logic", () => {
  it("updates payout wallet successfully", async () => {
    const mockResp = mockPayoutUpdateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(mockResp));

    const result = await updatePayout(
      "https://xenarch.bot",
      "xn_test_key",
      "0x" + "ab".repeat(20),
      "password123",
    );
    expect(result.confirmed).toBe(true);
    expect(result.effective_at).toBeDefined();
  });

  it("sends correct headers and body", async () => {
    const mockResp = mockPayoutUpdateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(mockResp));

    const wallet = "0x" + "cd".repeat(20);
    await updatePayout(
      "https://xenarch.bot",
      "xn_test_key",
      wallet,
      "mypassword",
      "base",
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://xenarch.bot/v1/publishers/me/payout",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer xn_test_key",
          "X-Confirm-Password": "mypassword",
        }),
        body: JSON.stringify({ wallet, network: "base" }),
      }),
    );
  });

  it("throws on invalid auth (401)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock401Response());

    await expect(
      updatePayout(
        "https://xenarch.bot",
        "bad_key",
        "0x" + "ab".repeat(20),
        "password123",
      ),
    ).rejects.toThrow("Failed to update payout");
  });

  it("throws on wrong password (403)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ error: "forbidden", message: "Invalid password", code: 403 }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      updatePayout(
        "https://xenarch.bot",
        "xn_test_key",
        "0x" + "ab".repeat(20),
        "wrongpass",
      ),
    ).rejects.toThrow("Failed to update payout");
  });

  it("uses default network 'base' when not specified", async () => {
    const mockResp = mockPayoutUpdateResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response(mockResp));

    await updatePayout(
      "https://xenarch.bot",
      "xn_test_key",
      "0x" + "ab".repeat(20),
      "password123",
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"network":"base"'),
      }),
    );
  });
});
