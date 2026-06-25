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
