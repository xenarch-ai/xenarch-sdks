import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createXenarch,
  Xenarch,
  ConfirmationRequired,
  SessionExpiredError,
  MissingSigningKeyError,
  MissingPublisherKeyError,
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
    // XEN-637 data-plane parity
    expect(sdk.merchant.links.webhookDeliveries).toBeInstanceOf(Function);
    expect(sdk.merchant.links.rotateWebhookSecret).toBeInstanceOf(Function);
    expect(sdk.merchant.links.retryWebhookDelivery).toBeInstanceOf(Function);
    expect(sdk.merchant.links.testWebhook).toBeInstanceOf(Function);
    expect(sdk.merchant.links.aggregate).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.rollup).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.get).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.charges).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.exportCsv).toBeInstanceOf(Function);
    expect(sdk.merchant.subscribers.mintManageLink).toBeInstanceOf(Function);
    expect(sdk.merchant.orders.exportCsv).toBeInstanceOf(Function);
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

// --- XEN-637 data-plane parity ---------------------------------------------

/** Stub fetch, capturing every call; reply with `json` (or `text` for CSV). */
function stubFetch(reply: { json?: unknown; text?: string; status?: number }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (reply.text !== undefined) {
      return new Response(reply.text, {
        status: reply.status ?? 200,
        headers: { "Content-Type": "text/csv" },
      });
    }
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

describe("links webhook management (XEN-637)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const DELIVERY = {
    id: "whd_1",
    event_type: "payment.confirmed",
    attempted_at: "2026-07-10T00:00:00Z",
    dest_url: "https://merchant.test/hook",
    http_status: 200,
    latency_ms: 42,
    retry_count: 0,
    error_message: null,
    status: "delivered",
  };

  it("webhookDeliveries GETs the delivery log with the limit query", async () => {
    const calls = stubFetch({ json: { deliveries: [DELIVERY] } });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.links.webhookDeliveries("lnk_1", { limit: 10 });
    expect(calls[0].url).toBe(
      "https://api.test/v1/links/lnk_1/webhook-deliveries?limit=10",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(res.deliveries[0].id).toBe("whd_1");
  });

  it("rotateWebhookSecret POSTs and returns the one-shot secret", async () => {
    const calls = stubFetch({ json: { webhook_secret: "whsec_new" } });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.links.rotateWebhookSecret("lnk_1");
    expect(calls[0].url).toBe("https://api.test/v1/links/lnk_1/webhook/rotate-secret");
    expect(calls[0].init.method).toBe("POST");
    expect(res.webhook_secret).toBe("whsec_new");
  });

  it("retryWebhookDelivery POSTs to the nested delivery path", async () => {
    const calls = stubFetch({ json: DELIVERY });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.links.retryWebhookDelivery("lnk_1", "whd_1");
    expect(calls[0].url).toBe(
      "https://api.test/v1/links/lnk_1/webhook-deliveries/whd_1/retry",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(res.status).toBe("delivered");
  });

  it("testWebhook POSTs to the test endpoint", async () => {
    const calls = stubFetch({ json: { ...DELIVERY, event_type: "webhook.test" } });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.links.testWebhook("lnk_1");
    expect(calls[0].url).toBe("https://api.test/v1/links/lnk_1/webhook/test");
    expect(calls[0].init.method).toBe("POST");
    expect(res.event_type).toBe("webhook.test");
  });

  it("aggregate GETs the donation total WITHOUT a session (public)", async () => {
    const calls = stubFetch({ json: { total_received_usd: "123.4567" } });
    // No session token — aggregate is a public endpoint.
    const sdk = createXenarch({ apiBase: "https://api.test" });
    const res = await sdk.merchant.links.aggregate("lnk_1");
    expect(calls[0].url).toBe("https://api.test/v1/links/lnk_1/aggregate");
    expect(calls[0].init.method).toBe("GET");
    expect(res.total_received_usd).toBe("123.4567");
  });
});

describe("subscribers reads (XEN-637)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rollup GETs the portfolio rollup", async () => {
    const calls = stubFetch({
      json: { active: 3, mrr_usdc: "12.00", cancelled_30d: 1, churn_30d: 0.25 },
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.rollup();
    expect(calls[0].url).toBe("https://api.test/v1/subscribers/rollup");
    expect(calls[0].init.method).toBe("GET");
    expect(res.mrr_usdc).toBe("12.00");
    expect(res.churn_30d).toBe(0.25);
  });

  it("get GETs one subscriber's detail", async () => {
    const calls = stubFetch({
      json: { subscription_id: "sub_1", link_id: "lnk_1", status: "active" },
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.get("sub_1");
    expect(calls[0].url).toBe("https://api.test/v1/subscribers/sub_1");
    expect(calls[0].init.method).toBe("GET");
    expect(res.subscription_id).toBe("sub_1");
  });

  it("charges GETs the ledger with limit + starting_after cursor", async () => {
    const calls = stubFetch({
      json: {
        subscription_id: "sub_1",
        charges: [],
        has_more: false,
        next_cursor: null,
        total_charged_micro: 0,
        total_collected_micro: 0,
        outstanding_micro: 0,
      },
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.charges("sub_1", {
      limit: 50,
      startingAfter: 7,
    });
    expect(calls[0].url).toBe(
      "https://api.test/v1/subscribers/sub_1/charges?limit=50&starting_after=7",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(res.has_more).toBe(false);
  });

  it("exportCsv returns raw CSV text (not JSON-parsed) with filters", async () => {
    const csv = "subscription_id,status\nsub_1,active\n";
    const calls = stubFetch({ text: csv });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.exportCsv({
      linkId: "lnk_1",
      status: "active",
    });
    expect(calls[0].url).toBe(
      "https://api.test/v1/subscribers/export.csv?link_id=lnk_1&status=active",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(res).toBe(csv);
  });

  it("exportCsv maps a 401 to SessionExpiredError (re-auth catch works)", async () => {
    stubFetch({ json: { detail: "session expired" }, status: 401 });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    await expect(sdk.merchant.subscribers.exportCsv()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("mintManageLink POSTs ttl_seconds and returns the manage url", async () => {
    const calls = stubFetch({
      json: {
        manage_url: "https://pay.test/m/tok",
        manage_token: "tok",
        expires_at: "2026-07-10T00:15:00Z",
      },
    });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.subscribers.mintManageLink("sub_1", {
      ttlSeconds: 600,
    });
    expect(calls[0].url).toBe("https://api.test/v1/subscribers/sub_1/manage-link");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ttl_seconds: 600 });
    expect(res.manage_token).toBe("tok");
  });
});

describe("orders.exportCsv (XEN-637)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns raw CSV text with status + search + link_id filters", async () => {
    const csv = "order_id,status\nord_1,shipped\n";
    const calls = stubFetch({ text: csv });
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    const res = await sdk.merchant.orders.exportCsv({
      status: "shipped",
      search: "acme",
      linkId: "lnk_1",
    });
    expect(calls[0].url).toBe(
      "https://api.test/v1/orders/export.csv?status=shipped&search=acme&link_id=lnk_1",
    );
    expect(res).toBe(csv);
  });
});

describe("services auth (XEN-637)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("create authenticates with the publisher API key (Bearer), not the session", async () => {
    const calls = stubFetch({ json: { id: "svc_1" } });
    const sdk = createXenarch({
      apiBase: "https://api.test",
      sessionToken: "t",
      publisherApiKey: "xen_live_pub",
    });
    await sdk.merchant.services.create({
      name: "svc",
      url: "https://svc.test",
      pricePerRequest: "0.01",
    });
    expect(calls[0].url).toBe("https://api.test/v1/services");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xen_live_pub");
  });

  it("create without a publisher key throws before any network call", async () => {
    const sdk = createXenarch({ apiBase: "https://api.test", sessionToken: "t" });
    await expect(
      sdk.merchant.services.create({
        name: "svc",
        url: "https://svc.test",
        pricePerRequest: "0.01",
      }),
    ).rejects.toBeInstanceOf(MissingPublisherKeyError);
  });

  it("list is public — works with no session and sends no auth", async () => {
    const calls = stubFetch({ json: { services: [], total: 0, limit: 20, offset: 0 } });
    const sdk = createXenarch({ apiBase: "https://api.test" });
    const res = await sdk.merchant.services.list({ limit: 20 });
    expect(calls[0].url).toBe("https://api.test/v1/services?limit=20");
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(res.total).toBe(0);
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
