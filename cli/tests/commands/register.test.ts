import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mock201Response,
  mock409Response,
  mockPublisherRegisterResponse,
} from "../fixtures/mock-responses.js";
import { registerPublisher } from "../../src/lib/api.js";
import { readConfig, writeConfig } from "../../src/lib/config.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

const originalFetch = globalThis.fetch;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "xenarch-test-"));
  globalThis.fetch = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("register command logic", () => {
  it("registers a publisher and returns api_key", async () => {
    const mockResp = mockPublisherRegisterResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock201Response(mockResp));

    const result = await registerPublisher(
      "https://xenarch.bot",
      "test@example.com",
      "password123",
    );
    expect(result.id).toBe(mockResp.id);
    expect(result.api_key).toBe(mockResp.api_key);
  });

  it("stores auth_token in config after registration", async () => {
    await writeConfig({ ...DEFAULT_CONFIG }, tmpDir);

    const mockResp = mockPublisherRegisterResponse();
    const config = await readConfig(tmpDir);
    config.auth_token = mockResp.api_key;
    await writeConfig(config, tmpDir);

    const saved = await readConfig(tmpDir);
    expect(saved.auth_token).toBe(mockResp.api_key);
  });

  it("throws on duplicate email (409)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock409Response("Email already registered"),
    );

    await expect(
      registerPublisher("https://xenarch.bot", "dup@example.com", "password123"),
    ).rejects.toThrow("Registration failed");
  });

  it("sends correct request body", async () => {
    const mockResp = mockPublisherRegisterResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock201Response(mockResp));

    await registerPublisher("https://xenarch.bot", "test@example.com", "password123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://xenarch.bot/v1/publishers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "test@example.com", password: "password123" }),
      }),
    );
  });
});
