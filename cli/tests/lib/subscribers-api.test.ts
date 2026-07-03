import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSubscriber,
  listSubscriberCharges,
  getSubscribersRollup,
  exportSubscribersCsv,
  merchantCancelSubscriber,
  suspendSubscriber,
  mintManageLink,
  setPeriodCap,
  listPermitCollectable,
  listMeteredCollectable,
} from "../../src/lib/api.js";
import { SESSION_COOKIE_NAME } from "../../src/types.js";
import { mock200Response } from "../fixtures/mock-responses.js";

const API = "https://api.test";
const TOKEN = "sess_abc";
const originalFetch = globalThis.fetch;

/** Read the (url, init) the wrapper passed to fetch on its Nth call. */
function callArgs(n = 0): { url: string; init: RequestInit } {
  const call = vi.mocked(globalThis.fetch).mock.calls[n];
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

function headerVal(init: RequestInit, name: string): string | undefined {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h[name];
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("subscriber lifecycle wrappers — path/verb/auth (XEN-518)", () => {
  it("getSubscriber → GET /v1/subscribers/{id} with the SIWE cookie", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", status: "active" }),
    );
    const res = await getSubscriber(API, TOKEN, "sub_1");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/sub_1`);
    expect(init.method ?? "GET").toBe("GET");
    expect(headerVal(init, "Cookie")).toBe(`${SESSION_COOKIE_NAME}=${TOKEN}`);
    expect(res.status).toBe("active");
  });

  it("getSubscriber URL-encodes the id", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({}));
    await getSubscriber(API, TOKEN, "sub/../x");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/sub%2F..%2Fx`);
  });

  it("listSubscriberCharges → GET .../charges?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", charges: [], has_more: false }),
    );
    await listSubscriberCharges(API, TOKEN, "sub_1", "limit=50&starting_after=7");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/sub_1/charges?limit=50&starting_after=7`);
  });

  it("listSubscriberCharges omits the '?' when the query is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ charges: [] }));
    await listSubscriberCharges(API, TOKEN, "sub_1");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/sub_1/charges`);
  });

  it("getSubscribersRollup → GET /v1/subscribers/rollup", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ active: 3, mrr_usdc: "9", churn_30d: null }),
    );
    const r = await getSubscribersRollup(API, TOKEN);
    expect(callArgs().url).toBe(`${API}/v1/subscribers/rollup`);
    expect(r.active).toBe(3);
  });

  it("exportSubscribersCsv → GET .../export.csv returns raw text (not JSON)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("subscription_id,status\nsub_1,active\n", { status: 200 }),
    );
    const csv = await exportSubscribersCsv(API, TOKEN, "status=active");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/export.csv?status=active`);
    // Text path never sets a JSON Content-Type request header.
    expect(headerVal(init, "Content-Type")).toBeUndefined();
    expect(csv).toContain("sub_1,active");
  });

  it("merchantCancelSubscriber → POST .../merchant-cancel, no body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", status: "cancelled" }),
    );
    const r = await merchantCancelSubscriber(API, TOKEN, "sub_1");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/sub_1/merchant-cancel`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(r.status).toBe("cancelled");
  });

  it("suspendSubscriber → POST .../suspend", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ subscription_id: "sub_1", status: "failed" }),
    );
    const r = await suspendSubscriber(API, TOKEN, "sub_1");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/sub_1/suspend`);
    expect(callArgs().init.method).toBe("POST");
    expect(r.status).toBe("failed");
  });

  it("mintManageLink → POST .../manage-link with an empty body when no ttl", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ manage_url: "https://x/s/1", manage_token: "mtok", expires_at: "2026-07-03T00:00:00Z" }),
    );
    await mintManageLink(API, TOKEN, "sub_1");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/sub_1/manage-link`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("mintManageLink includes ttl_seconds when supplied", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ manage_url: "u", manage_token: "mtok", expires_at: "t" }),
    );
    await mintManageLink(API, TOKEN, "sub_1", 3600);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ ttl_seconds: 3600 });
  });

  it("setPeriodCap → POST .../period-cap?token=<manage> with {new_cap_usdc}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({
        subscription_id: "sub_1",
        status: "active",
        period_cap_micro: 25000000,
        period_cap_usdc: "25",
        exceeds_permit_runway: false,
        remaining_permit_micro: 100000000,
      }),
    );
    const r = await setPeriodCap(API, TOKEN, "sub_1", "mtok", "25");
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/subscribers/sub_1/period-cap?token=mtok`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ new_cap_usdc: "25" });
    expect(r.period_cap_usdc).toBe("25");
  });

  it("listPermitCollectable / listMeteredCollectable hit the two bags", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ collectable: [], count: 0, total_micro: 0 }),
    );
    await listPermitCollectable(API, TOKEN, "link_id=lnk_1");
    expect(callArgs().url).toBe(`${API}/v1/subscribers/permit/collectable?link_id=lnk_1`);

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ collectable: [], count: 0, total_micro: 0 }),
    );
    await listMeteredCollectable(API, TOKEN);
    expect(callArgs().url).toBe(`${API}/v1/subscribers/metered/collectable`);
  });
});
