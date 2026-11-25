import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseNetworkSpec } from "../../src/lib/networks.js";
import { getNetworks, getLinkNetworks, putLinkNetworks } from "../../src/lib/api.js";
import { mock200Response } from "../fixtures/mock-responses.js";

describe("parseNetworkSpec (XEN-719)", () => {
  it("builds the whole-state body, merging + and repeated coins, dropping base", () => {
    expect(parseNetworkSpec("base:USDC,ethereum:usdc+USDT,bnb:USDT,bnb:USDC")).toEqual({
      ethereum: { tokens: ["USDC", "USDT"] },
      bnb: { tokens: ["USDT", "USDC"] },
    });
  });

  it("puts --tron-address on tron as pay_to", () => {
    expect(parseNetworkSpec("tron:USDT", " TXYZ ")).toEqual({
      tron: { tokens: ["USDT"], pay_to: "TXYZ" },
    });
  });

  it("refuses tron without an address", () => {
    expect(() => parseNetworkSpec("tron:USDT")).toThrow(/--tron-address/);
  });

  it("refuses --tron-address without tron", () => {
    expect(() => parseNetworkSpec("ethereum:USDC", "TXYZ")).toThrow(/only applies/);
  });

  it("'none' and '' mean Base USDC only", () => {
    expect(parseNetworkSpec("none")).toEqual({});
    expect(parseNetworkSpec("")).toEqual({});
  });

  it("rejects an entry without coins", () => {
    expect(() => parseNetworkSpec("ethereum")).toThrow(/network:COIN/);
  });
});

describe("networks API wrappers (XEN-719)", () => {
  const API = "https://api.test";
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });
  const call = (n = 0) => {
    const c = vi.mocked(globalThis.fetch).mock.calls[n];
    return { url: c[0] as string, init: (c[1] ?? {}) as RequestInit };
  };

  it("getNetworks → public GET /v1/networks", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ networks: [] }));
    await getNetworks(API);
    expect(call().url).toBe(`${API}/v1/networks`);
  });

  it("getLinkNetworks → GET with the session cookie", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: "lnk_1" }));
    await getLinkNetworks(API, "sess", "lnk_1");
    const { url, init } = call();
    expect(url).toBe(`${API}/v1/links/lnk_1/networks`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Cookie).toContain("sess");
  });

  it("putLinkNetworks → PUT {networks}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: "lnk_1" }));
    await putLinkNetworks(API, "sess", "lnk_1", { tron: { tokens: ["USDT"], pay_to: "TXYZ" } });
    const { url, init } = call();
    expect(url).toBe(`${API}/v1/links/lnk_1/networks`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      networks: { tron: { tokens: ["USDT"], pay_to: "TXYZ" } },
    });
  });
});
