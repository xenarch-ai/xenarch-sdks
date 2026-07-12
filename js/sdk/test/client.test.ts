import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createXenarch,
  Xenarch,
  ConfirmationRequired,
  SessionExpiredError,
  MissingSigningKeyError,
} from "../src/index.js";

describe("createXenarch", () => {
  it("builds a client with the bilingual namespaces", () => {
    const sdk = createXenarch({ sessionToken: "t", privateKey: "0x1" });
    expect(sdk).toBeInstanceOf(Xenarch);
    expect(sdk.merchant.links).toBeDefined();
    expect(sdk.merchant.payments).toBeDefined();
    expect(sdk.merchant.subscribers).toBeDefined();
    expect(sdk.merchant.profile).toBeDefined();
    expect(sdk.x402).toBeDefined();
    expect(sdk.webhooks.verify).toBeInstanceOf(Function);
  });

  it("defaults the api base and strips trailing slashes", () => {
    expect(createXenarch().apiBase).toBe("https://api.xenarch.dev");
    expect(createXenarch({ apiBase: "https://x.dev/" }).apiBase).toBe("https://x.dev");
  });
});

describe("confirm gate", () => {
  it("blocks create without confirm by default (before any network call)", async () => {
    const sdk = createXenarch({ sessionToken: "t", privateKey: "0x1" });
    await expect(sdk.merchant.links.create({})).rejects.toBeInstanceOf(
      ConfirmationRequired,
    );
  });

  it("blocks revoke without confirm by default", async () => {
    const sdk = createXenarch({ sessionToken: "t" });
    await expect(sdk.merchant.links.revoke("abc")).rejects.toBeInstanceOf(
      ConfirmationRequired,
    );
  });

  it("requireConfirm:false bypasses the gate (falls through to the real op)", async () => {
    // No session → the next thing revoke hits is the session check, proving
    // the confirm gate was skipped.
    const sdk = createXenarch({ requireConfirm: false });
    await expect(sdk.merchant.links.revoke("abc")).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe("auth + signing guards", () => {
  it("merchant ops without a session throw SessionExpiredError", async () => {
    const sdk = createXenarch({});
    await expect(sdk.merchant.payments.list()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("x402.pay without a signing key throws MissingSigningKeyError", async () => {
    const sdk = createXenarch({ sessionToken: "t" });
    await expect(sdk.x402.pay("https://example.com")).rejects.toBeInstanceOf(
      MissingSigningKeyError,
    );
  });
});

describe("v1.2 parity surface", () => {
  it("exposes the new namespaces", () => {
    const sdk = createXenarch({ sessionToken: "t" });
    expect(sdk.merchant.usage.report).toBeInstanceOf(Function);
    expect(sdk.merchant.orders).toBeDefined();
    expect(sdk.merchant.services).toBeDefined();
    expect(sdk.merchant.groups).toBeDefined();
    expect(sdk.merchant.assets).toBeDefined();
    expect(sdk.merchant.earnings).toBeDefined();
    expect(sdk.merchant.subscribers.meteredCollectable).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.meteredCollect).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.meteredCollectPrepare).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.collect).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.suspend).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.unsuspend).toBeInstanceOf(Function);
    expect(sdk.merchant.links.capSuggestions).toBeInstanceOf(Function);
    expect(sdk.agent.getCaps).toBeInstanceOf(Function);
    expect(sdk.agent.keys.create).toBeInstanceOf(Function);
    expect(sdk.info.usdcUsdRate).toBeInstanceOf(Function);
  });

  it("metered collect surfaces are session-gated", async () => {
    const sdk = createXenarch({});
    await expect(sdk.merchant.subscribers.meteredCollectable()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe("usage.report (webhook_secret auth, no session needed)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the increment to the link's usage endpoint with Bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          subscription_id: "sub_1",
          accrued_units: "42",
          accepted: true,
          deduped: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // No session token — usage reporting authenticates with the link secret.
    const sdk = createXenarch({ apiBase: "https://api.test" });
    const res = await sdk.merchant.usage.report(
      "lnk_abc",
      { subscriptionId: "sub_1", units: 7, idempotencyKey: "k1" },
      { secret: "whsec_xyz" },
    );

    expect(res.accrued_units).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.test/v1/links/lnk_abc/usage");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer whsec_xyz");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({
      subscription_id: "sub_1",
      units: 7,
      idempotency_key: "k1",
      source: "webhook",
    });
  });
});

describe("subscribers.meteredCollectPrepare + collect (XEN-634)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const PREP = {
    subscription_id: "sub_1",
    amount_micro: 6000700,
    amount_usdc: "6.0007",
    owner: "0x2222222222222222222222222222222222222222",
    spender: "0x7FE6b933cA47D4a4f2cD9A98c12592041e7Db993",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chain_id: 8453,
    collectable: true,
    collectable_reason: null,
    steps: [
      { name: "permit", to: "0x8335", data: "0xd505accf", value: "0" },
      { name: "transferFrom", to: "0x8335", data: "0x23b872dd", value: "0" },
    ],
  };

  it("meteredCollectPrepare GETs the prepare endpoint and returns steps", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(PREP), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.meteredCollectPrepare("sub_1");
    expect(calls[0].url).toBe(
      "https://api.test/v1/subscribers/sub_1/metered/collect/prepare",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(res.steps.map((s) => s.name)).toEqual(["permit", "transferFrom"]);
    expect(res.amount_usdc).toBe("6.0007");
  });

  it("collect orchestrates prepare → sign each step → record the transferFrom hash", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.endsWith("/metered/collect/prepare")) {
        return new Response(JSON.stringify(PREP), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // the record call
      return new Response(
        JSON.stringify({
          subscription_id: "sub_1",
          settled_count: 1,
          settled_micro: 6000700,
          status: "active",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const signed: string[] = [];
    const signer = {
      async sendTransaction(tx: { to: string; data: string; value: string }) {
        signed.push(tx.data);
        return `0xhash_${tx.data.slice(0, 10)}`;
      },
    };
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.collect("sub_1", signer);

    // both steps signed, in order
    expect(signed).toEqual(["0xd505accf", "0x23b872dd"]);
    // recorded the TRANSFERFROM hash (not the permit hash)
    const recordCall = urls.find((u) => u.endsWith("/metered/collect"));
    expect(recordCall).toBe("https://api.test/v1/subscribers/sub_1/metered/collect");
    expect(res.settled_micro).toBe(6000700);
  });
});

describe("links.capSuggestions (XEN-625)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes cap-suggestions with the decimal-string body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ link_id: "lnk_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    await sdk.merchant.links.capSuggestions("lnk_1", {
      suggested_period_cap_usdc: "10",
      suggested_cap_usdc: "100",
    });
    expect(calls[0].url).toBe("https://api.test/v1/links/lnk_1/cap-suggestions");
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      suggested_period_cap_usdc: "10",
      suggested_cap_usdc: "100",
    });
  });
});
