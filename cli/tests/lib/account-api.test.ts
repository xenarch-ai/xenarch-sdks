import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  updateMeAgent,
  getMeAgentReceipt,
  getAgentWebhook,
  putAgentWebhook,
  rotateAgentWebhookSecret,
  retryAgentWebhookDelivery,
  listWallets,
  unlinkWallet,
  setWalletLabel,
  transferOwner,
  createMerchantKey,
  listMerchantKeys,
  rotateMerchantKey,
  revokeMerchantKey,
  createInvite,
  listInvites,
  revokeInvite,
  setOnboardingEmail,
  verifyOnboardingEmail,
  getEarningsSummary,
} from "../../src/lib/api.js";
import { mock200Response } from "../fixtures/mock-responses.js";

const API = "https://api.test";
const T = "sess_abc";
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

describe("agent profile / receipt / webhook wrappers (XEN-518)", () => {
  it("updateMeAgent → PUT /v1/me/agent with the body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "a1", display_name: "Bot" }));
    await updateMeAgent(API, T, { display_name: "Bot", label: "prod" });
    const { url, init } = callArgs();
    expect(url).toBe(`${API}/v1/me/agent`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ display_name: "Bot", label: "prod" });
  });

  it("getMeAgentReceipt → GET /v1/me/agent/receipts/{id}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "r1", amount_usd: "0.01" }));
    await getMeAgentReceipt(API, T, "r1");
    expect(callArgs().url).toBe(`${API}/v1/me/agent/receipts/r1`);
  });

  it("getAgentWebhook / putAgentWebhook hit /v1/me/agent/webhooks", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ configured: false, url: null, event_types: null, enabled: false, available_event_types: [] }),
    );
    await getAgentWebhook(API, T);
    expect(callArgs().url).toBe(`${API}/v1/me/agent/webhooks`);

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ configured: true, url: "https://x", event_types: null, enabled: true, available_event_types: [] }),
    );
    const body = { url: "https://x", event_types: null, enabled: true };
    await putAgentWebhook(API, T, body);
    expect(callArgs().url).toBe(`${API}/v1/me/agent/webhooks`);
    expect(callArgs().init.method).toBe("PUT");
    expect(JSON.parse(callArgs().init.body as string)).toEqual(body);
  });

  it("rotateAgentWebhookSecret → POST .../rotate-secret returns {secret}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ secret: "whsec" }));
    const r = await rotateAgentWebhookSecret(API, T);
    expect(callArgs().url).toBe(`${API}/v1/me/agent/webhooks/rotate-secret`);
    expect(callArgs().init.method).toBe("POST");
    expect(r.secret).toBe("whsec");
  });

  it("retryAgentWebhookDelivery → POST .../webhooks/deliveries/{id}/retry", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "d1", status: "queued" }));
    await retryAgentWebhookDelivery(API, T, "d1");
    expect(callArgs().url).toBe(`${API}/v1/me/agent/webhooks/deliveries/d1/retry`);
    expect(callArgs().init.method).toBe("POST");
  });
});

describe("wallets wrappers (XEN-518)", () => {
  it("listWallets → GET /v1/me/wallets", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ wallets: [] }));
    await listWallets(API, T);
    expect(callArgs().url).toBe(`${API}/v1/me/wallets`);
  });

  it("unlinkWallet → DELETE /v1/me/wallets/{addr}, 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const r = await unlinkWallet(API, T, "0xabc");
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/0xabc`);
    expect(callArgs().init.method).toBe("DELETE");
    expect(r).toBeUndefined();
  });

  it("setWalletLabel → PUT .../label with {label}, null clears", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await setWalletLabel(API, T, "0xabc", null);
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/0xabc/label`);
    expect(callArgs().init.method).toBe("PUT");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ label: null });
  });

  it("transferOwner → POST /v1/me/wallets/owner with {new_owner}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ owner_wallet: "0xdef" }));
    const r = await transferOwner(API, T, "0xdef");
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/owner`);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ new_owner: "0xdef" });
    expect(r.owner_wallet).toBe("0xdef");
  });
});

describe("merchant keys wrappers (XEN-518)", () => {
  it("createMerchantKey → POST /v1/me/merchant/keys with {label}", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "k1", plaintext: "xm_live_x" }));
    await createMerchantKey(API, T, "server");
    expect(callArgs().url).toBe(`${API}/v1/me/merchant/keys`);
    expect(callArgs().init.method).toBe("POST");
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ label: "server" });
  });

  it("listMerchantKeys → GET /v1/me/merchant/keys", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response([]));
    await listMerchantKeys(API, T);
    expect(callArgs().url).toBe(`${API}/v1/me/merchant/keys`);
  });

  it("rotateMerchantKey → POST /v1/me/merchant/keys/{id}/rotate", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ id: "k1", plaintext: "xm_live_y" }));
    await rotateMerchantKey(API, T, "k1");
    expect(callArgs().url).toBe(`${API}/v1/me/merchant/keys/k1/rotate`);
    expect(callArgs().init.method).toBe("POST");
  });

  it("revokeMerchantKey → DELETE /v1/me/merchant/keys/{id}, 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const r = await revokeMerchantKey(API, T, "k1");
    expect(callArgs().url).toBe(`${API}/v1/me/merchant/keys/k1`);
    expect(callArgs().init.method).toBe("DELETE");
    expect(r).toBeUndefined();
  });
});

describe("invites, email, earnings wrappers (XEN-518)", () => {
  it("createInvite → POST /v1/me/wallets/invite with the body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ token: "t", join_url: "u", expires_at: "e", label: null, role: "operator" }),
    );
    await createInvite(API, T, { role: "operator", label: "Maria" });
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/invite`);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ role: "operator", label: "Maria" });
  });

  it("listInvites → GET /v1/me/wallets/invites", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ invites: [] }));
    await listInvites(API, T);
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/invites`);
  });

  it("revokeInvite → DELETE /v1/me/wallets/invite/{id}, 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await revokeInvite(API, T, "inv1");
    expect(callArgs().url).toBe(`${API}/v1/me/wallets/invite/inv1`);
    expect(callArgs().init.method).toBe("DELETE");
  });

  it("setOnboardingEmail / verifyOnboardingEmail hit /v1/onboarding/email(+/verify)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mock200Response({ email: "a@b.com", sent: true }));
    await setOnboardingEmail(API, T, "a@b.com");
    expect(callArgs().url).toBe(`${API}/v1/onboarding/email`);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ email: "a@b.com" });

    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({ identity_id: "i1", email: "a@b.com", email_verified_at: "t" }),
    );
    await verifyOnboardingEmail(API, T, "1234");
    expect(callArgs().url).toBe(`${API}/v1/onboarding/email/verify`);
    expect(JSON.parse(callArgs().init.body as string)).toEqual({ code: "1234" });
  });

  it("getEarningsSummary → GET /v1/earnings/summary", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mock200Response({
        today: { earned_usd: "0", payment_count: 0 },
        month: { earned_usd: "0", payment_count: 0 },
        all_time: { earned_usd: "0", payment_count: 0 },
      }),
    );
    const r = await getEarningsSummary(API, T);
    expect(callArgs().url).toBe(`${API}/v1/earnings/summary`);
    expect(r.all_time.payment_count).toBe(0);
  });
});
