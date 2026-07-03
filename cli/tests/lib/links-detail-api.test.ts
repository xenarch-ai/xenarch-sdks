import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  updateLinkMetadata,
  listLinkEvents,
  getLinksRollup,
  getLinksSummary,
  assignLinkGroup,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listOrders,
  shipOrder,
  exportOrdersCsv,
  getLinkWebhook,
  putLinkWebhook,
  rotateLinkWebhookSecret,
  testLinkWebhook,
  listLinkWebhookDeliveries,
  retryLinkWebhookDelivery,
} from "../../src/lib/api.js";
import { mock200Response } from "../fixtures/mock-responses.js";

const API = "https://api.test";
const TOKEN = "sess_abc";
const LID = "lnk_1";
const originalFetch = globalThis.fetch;

function callArgs(n = 0): { url: string; init: RequestInit } {
  const call = vi.mocked(globalThis.fetch).mock.calls[n];
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("pay-link detail surface wrappers (XEN-518)", () => {
  it("updateLinkMetadata → PATCH .../metadata with {metadata}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: LID }));
    await updateLinkMetadata(API, TOKEN, LID, { metadata: { a: "1" } });
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/links/${LID}/metadata`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ metadata: { a: "1" } });
  });

  it("updateLinkMetadata sends metadata:null to clear", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: LID }));
    await updateLinkMetadata(API, TOKEN, LID, { metadata: null });
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ metadata: null });
  });

  it("listLinkEvents → GET .../events?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ events: [], next_cursor: null }));
    await listLinkEvents(API, TOKEN, LID, "types=payment.confirmed&limit=50");
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/events?types=payment.confirmed&limit=50`);
  });

  it("getLinksRollup / getLinksSummary hit the collection endpoints", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ paid_24h: 0, paid_total: 0, mtd_revenue_usdc: "0", views: 0, conversion: null }),
    );
    await getLinksRollup(API, TOKEN);
    expect(callArgs().url).toBe(`${API}/v1/links/rollup`);

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ period: "7d", revenue_usd: "0", paid_count: 0, link_count: 0 }),
    );
    await getLinksSummary(API, TOKEN, "period=7d");
    expect(callArgs().url).toBe(`${API}/v1/links/summary?period=7d`);
  });

  it("assignLinkGroup → PATCH .../group with {group_id}, null ungroups", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: LID, group_id: null }));
    await assignLinkGroup(API, TOKEN, LID, "grp_1");
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/group`);
    expect(callArgs().init.method).toBe("PATCH");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ group_id: "grp_1" });

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ link_id: LID, group_id: null }));
    await assignLinkGroup(API, TOKEN, LID, null);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ group_id: null });
  });
});

describe("groups wrappers (XEN-518)", () => {
  it("listGroups → GET /v1/groups", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ groups: [] }));
    await listGroups(API, TOKEN);
    expect(callArgs().url).toBe(`${API}/v1/groups`);
  });

  it("createGroup → POST /v1/groups with the body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "grp_1", name: "A" }));
    await createGroup(API, TOKEN, { name: "A", accent_kind: "empty" });
    expect(callArgs().url).toBe(`${API}/v1/groups`);
    expect(callArgs().init.method).toBe("POST");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ name: "A", accent_kind: "empty" });
  });

  it("updateGroup → PATCH /v1/groups/{id}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "grp_1", name: "B" }));
    await updateGroup(API, TOKEN, "grp_1", { name: "B", position: 2 });
    expect(callArgs().url).toBe(`${API}/v1/groups/grp_1`);
    expect(callArgs().init.method).toBe("PATCH");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ name: "B", position: 2 });
  });

  it("deleteGroup → DELETE /v1/groups/{id}, resolves on 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const r = await deleteGroup(API, TOKEN, "grp_1");
    expect(callArgs().url).toBe(`${API}/v1/groups/grp_1`);
    expect(callArgs().init.method).toBe("DELETE");
    expect(r).toBeUndefined();
  });
});

describe("orders wrappers (XEN-518)", () => {
  it("listOrders → GET /v1/orders?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ orders: [], has_more: false, next_cursor: null }),
    );
    await listOrders(API, TOKEN, "status=paid&limit=25");
    expect(callArgs().url).toBe(`${API}/v1/orders?status=paid&limit=25`);
  });

  it("shipOrder → POST /v1/orders/{id}/ship with {tracking, carrier}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ order_id: "ord_1", status: "shipped", tracking: "1Z" }),
    );
    await shipOrder(API, TOKEN, "ord_1", { tracking: "1Z", carrier: "UPS" });
    expect(callArgs().url).toBe(`${API}/v1/orders/ord_1/ship`);
    expect(callArgs().init.method).toBe("POST");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ tracking: "1Z", carrier: "UPS" });
  });

  it("exportOrdersCsv → GET /v1/orders/export.csv returns text", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("order_id,status\nord_1,paid\n", { status: 200 }),
    );
    const csv = await exportOrdersCsv(API, TOKEN, "status=paid");
    expect(callArgs().url).toBe(`${API}/v1/orders/export.csv?status=paid`);
    expect(csv).toContain("ord_1,paid");
  });
});

describe("pay-link webhook wrappers (XEN-518)", () => {
  it("getLinkWebhook → GET .../webhook", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ url: null, event_types: null, enabled: false, available_event_types: [] }),
    );
    await getLinkWebhook(API, TOKEN, LID);
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook`);
  });

  it("putLinkWebhook → PUT .../webhook with the body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ url: "https://x", event_types: ["payment.confirmed"], enabled: true, available_event_types: [] }),
    );
    const body = { url: "https://x", event_types: ["payment.confirmed"], enabled: true };
    await putLinkWebhook(API, TOKEN, LID, body);
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook`);
    expect(callArgs().init.method).toBe("PUT");
    expect(JSON.parse(callArgs().init.body as string)).toEqual(body);
  });

  it("rotateLinkWebhookSecret → POST .../webhook/rotate-secret", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ webhook_secret: "whsec" }));
    const r = await rotateLinkWebhookSecret(API, TOKEN, LID);
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook/rotate-secret`);
    expect(callArgs().init.method).toBe("POST");
    expect(r.webhook_secret).toBe("whsec");
  });

  it("testLinkWebhook → POST .../webhook/test", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ id: "d1", event_type: "webhook.test", status: "queued", dest_url: "https://x" }),
    );
    await testLinkWebhook(API, TOKEN, LID);
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook/test`);
    expect(callArgs().init.method).toBe("POST");
  });

  it("listLinkWebhookDeliveries → GET .../webhook-deliveries?<query>", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ deliveries: [] }));
    await listLinkWebhookDeliveries(API, TOKEN, LID, "limit=50");
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook-deliveries?limit=50`);
  });

  it("retryLinkWebhookDelivery → POST .../webhook-deliveries/{did}/retry", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ id: "d1", event_type: "payment.confirmed", status: "queued", dest_url: "https://x" }),
    );
    await retryLinkWebhookDelivery(API, TOKEN, LID, "d1");
    expect(callArgs().url).toBe(`${API}/v1/links/${LID}/webhook-deliveries/d1/retry`);
    expect(callArgs().init.method).toBe("POST");
  });
});
