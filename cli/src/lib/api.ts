import type {
  GateResponse,
  VerifiedPaymentResponse,
  GateStatusResponse,
  AgentRegisterResponse,
  PayJsonPricing,
  PublisherRegisterResponse,
  SiteCreateResponse,
  SiteListItem,
  SiteStatsResponse,
  PayoutUpdateResponse,
  SiweNonceResponse,
  MeAgentProfile,
  AgentSummary,
  AgentCaps,
  AgentCapsPut,
  CapResetResult,
  ScopeReadResult,
  ScopeRuleInput,
  ScopeMode,
  PauseResult,
  AgentApiKeySummary,
  AgentApiKeyIssued,
  AgentReceiptList,
  PayLinkSchemaResponse,
  PayLinkValidateResponse,
  PayLinkCreateBody,
  PayLinkCreateResponse,
  PayLinkListResponse,
  PayLinkDetail,
  PayLinkRevokeResponse,
  MerchantPaymentListResponse,
  SubscriberListResponse,
  MerchantProfileResponse,
  MerchantProfileBody,
  PayLinkInitiateResponse,
  PayLinkClaimResponse,
} from "../types.js";
import { GATE_ID_HEADER, TX_HASH_HEADER, SESSION_COOKIE_NAME } from "../types.js";

export interface PlatformConfig {
  wc_project_id: string;
}

export async function fetchPlatformConfig(
  apiBase: string,
): Promise<PlatformConfig> {
  const res = await fetch(`${apiBase}/v1/config`, {
    headers: { "User-Agent": "xenarch-cli/0.3.0" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch platform config: ${res.statusText}`);
  }

  return (await res.json()) as PlatformConfig;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = body.detail ?? body.message;
    if (detail === undefined || detail === null) return res.statusText;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors (422) return `detail` as an array of
    // { loc, msg, type } objects; stringify so callers don't surface the
    // useless "[object Object]" that `new Error(detail)` would produce.
    if (Array.isArray(detail)) {
      return detail.map((d) => d?.msg ?? JSON.stringify(d)).join("; ");
    }
    return JSON.stringify(detail);
  } catch {
    return res.statusText;
  }
}

export interface FetchGateResult {
  gated: boolean;
  gate: GateResponse | null;
}

export async function fetchGate(url: string): Promise<FetchGateResult> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "xenarch-cli/0.3.0",
    },
  });

  if (res.status !== 402) {
    return { gated: false, gate: null };
  }

  const body = await res.json();
  if (!body.xenarch) {
    return { gated: false, gate: null };
  }

  return { gated: true, gate: body as GateResponse };
}

/**
 * Eagerly re-verify an on-chain payment with the Xenarch platform.
 *
 * Post-XEN-179: returns the {@link VerifiedPaymentResponse} record (no
 * access token). Calling this is optional — most agents just replay the
 * gated URL with `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash` headers and
 * let the publisher's middleware verify behind the scenes.
 */
export async function verifyPayment(
  verifyUrl: string,
  txHash: string,
): Promise<VerifiedPaymentResponse> {
  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_hash: txHash }),
  });

  if (!res.ok) {
    throw new Error(`Payment verification failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as VerifiedPaymentResponse;
}

/**
 * Replay a gated URL with the canonical Xenarch V2 headers.
 *
 * The publisher's middleware reads {@link GATE_ID_HEADER} +
 * {@link TX_HASH_HEADER} (case-insensitive) and stateless-verifies the
 * payment before serving the content.
 */
export async function fetchWithReplay(
  url: string,
  gateId: string,
  txHash: string,
): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "xenarch-cli/0.3.0",
      [GATE_ID_HEADER]: gateId,
      [TX_HASH_HEADER]: txHash,
    },
  });
}

export async function getGateStatus(
  apiBase: string,
  gateId: string,
): Promise<GateStatusResponse> {
  const res = await fetch(`${apiBase}/v1/gates/${gateId}`);

  if (!res.ok) {
    throw new Error(`Failed to get gate status: ${await errorMessage(res)}`);
  }

  return (await res.json()) as GateStatusResponse;
}

export async function registerAgent(
  apiBase: string,
  walletAddress: string,
  name?: string,
): Promise<AgentRegisterResponse> {
  const body: Record<string, string> = { wallet_address: walletAddress };
  if (name) body.name = name;

  const res = await fetch(`${apiBase}/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Agent registration failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as AgentRegisterResponse;
}

export async function fetchPayJson(
  originUrl: string,
): Promise<PayJsonPricing | null> {
  try {
    const origin = new URL(originUrl).origin;
    const res = await fetch(`${origin}/.well-known/pay.json`, {
      headers: { "User-Agent": "xenarch-cli/0.3.0" },
    });

    if (!res.ok) return null;
    return (await res.json()) as PayJsonPricing;
  } catch {
    return null;
  }
}

// --- Publisher API ---

export async function registerPublisher(
  apiBase: string,
  email: string,
  password: string,
): Promise<PublisherRegisterResponse> {
  const res = await fetch(`${apiBase}/v1/publishers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(`Registration failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as PublisherRegisterResponse;
}

export async function createSite(
  apiBase: string,
  authToken: string,
  domain: string,
): Promise<SiteCreateResponse> {
  const res = await fetch(`${apiBase}/v1/sites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ domain }),
  });

  if (!res.ok) {
    throw new Error(`Failed to add site: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteCreateResponse;
}

export async function listSites(
  apiBase: string,
  authToken: string,
): Promise<SiteListItem[]> {
  const res = await fetch(`${apiBase}/v1/sites`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list sites: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteListItem[];
}

export async function getSiteStats(
  apiBase: string,
  authToken: string,
  siteId: string,
): Promise<SiteStatsResponse> {
  const res = await fetch(`${apiBase}/v1/sites/${siteId}/stats`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to get stats: ${await errorMessage(res)}`);
  }

  return (await res.json()) as SiteStatsResponse;
}

export async function loginPublisher(
  apiBase: string,
  email: string,
  password: string,
): Promise<{ api_key: string }> {
  const res = await fetch(`${apiBase}/v1/publishers/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }

  return (await res.json()) as { api_key: string };
}

export async function updatePayout(
  apiBase: string,
  authToken: string,
  wallet: string,
  password: string,
  network: string = "base",
): Promise<PayoutUpdateResponse> {
  const res = await fetch(`${apiBase}/v1/publishers/me/payout`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      "X-Confirm-Password": password,
    },
    body: JSON.stringify({ wallet, network }),
  });

  if (!res.ok) {
    throw new Error(`Failed to update payout: ${await errorMessage(res)}`);
  }

  return (await res.json()) as PayoutUpdateResponse;
}

// --- Agent control plane (SIWE session: /v1/me/agent/*) ---

/** Thrown when the SIWE session cookie is missing/expired (HTTP 401). */
export class SessionExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export async function siweNonce(apiBase: string): Promise<SiweNonceResponse> {
  const res = await fetch(`${apiBase}/v1/auth/siwe/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to get SIWE nonce: ${await errorMessage(res)}`);
  }
  return (await res.json()) as SiweNonceResponse;
}

/**
 * Verify the signed EIP-4361 message and capture the session cookie.
 *
 * The platform sets `xen_session` as an HttpOnly Set-Cookie. HttpOnly only
 * blocks *browser* JS — a CLI HTTP client reads it off the response headers
 * via `getSetCookie()` and replays it as a request `Cookie` header.
 */
export async function siweVerify(
  apiBase: string,
  message: string,
  signature: string,
): Promise<{ token: string }> {
  const res = await fetch(`${apiBase}/v1/auth/siwe/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    throw new Error(`SIWE verification failed: ${await errorMessage(res)}`);
  }

  // Node's fetch (undici) exposes multiple Set-Cookie headers via
  // getSetCookie(); fall back to the combined header for other runtimes.
  const getSetCookie = (
    res.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const cookies: string[] = getSetCookie
    ? getSetCookie.call(res.headers)
    : (res.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/);

  for (const c of cookies) {
    const m = c.match(new RegExp(`(?:^|\\s)${SESSION_COOKIE_NAME}=([^;]+)`));
    if (m) return { token: m[1] };
  }
  throw new Error(
    "SIWE verify succeeded but no session cookie was returned by the server.",
  );
}

/**
 * Authenticated request against the agent control plane. Sends the SIWE
 * session as a Cookie header. Throws {@link SessionExpiredError} on 401 so
 * callers can prompt `xenarch agent login`.
 */
async function meAgentRequest<T>(
  apiBase: string,
  sessionToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}/v1/me/agent${path}`, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new SessionExpiredError(await errorMessage(res));
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  // 204 No Content (key revoke) has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function getMeAgent(apiBase: string, token: string): Promise<MeAgentProfile> {
  return meAgentRequest<MeAgentProfile>(apiBase, token, "GET", "");
}

export function getAgentSummary(
  apiBase: string,
  token: string,
  period = "24h",
): Promise<AgentSummary> {
  return meAgentRequest<AgentSummary>(
    apiBase,
    token,
    "GET",
    `/summary?period=${period}`,
  );
}

export function getAgentCaps(apiBase: string, token: string): Promise<AgentCaps> {
  return meAgentRequest<AgentCaps>(apiBase, token, "GET", "/caps");
}

export function putAgentCaps(
  apiBase: string,
  token: string,
  caps: AgentCapsPut,
): Promise<AgentCaps> {
  return meAgentRequest<AgentCaps>(apiBase, token, "PUT", "/caps", caps);
}

export function resetAgentDayCap(
  apiBase: string,
  token: string,
): Promise<CapResetResult> {
  return meAgentRequest<CapResetResult>(apiBase, token, "POST", "/caps/reset-day");
}

export function getAgentScope(apiBase: string, token: string): Promise<ScopeReadResult> {
  return meAgentRequest<ScopeReadResult>(apiBase, token, "GET", "/scope");
}

export function putAgentScope(
  apiBase: string,
  token: string,
  defaultMode: ScopeMode,
  rules: ScopeRuleInput[],
): Promise<ScopeReadResult> {
  return meAgentRequest<ScopeReadResult>(apiBase, token, "PUT", "/scope", {
    default_mode: defaultMode,
    rules,
  });
}

export function setAgentPause(
  apiBase: string,
  token: string,
  paused: boolean,
): Promise<PauseResult> {
  return meAgentRequest<PauseResult>(apiBase, token, "POST", "/pause", { paused });
}

export function listAgentKeys(
  apiBase: string,
  token: string,
): Promise<AgentApiKeySummary[]> {
  return meAgentRequest<AgentApiKeySummary[]>(apiBase, token, "GET", "/keys");
}

export function createAgentKey(
  apiBase: string,
  token: string,
  label: string | null,
): Promise<AgentApiKeyIssued> {
  return meAgentRequest<AgentApiKeyIssued>(apiBase, token, "POST", "/keys", {
    label,
  });
}

export function rotateAgentKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<AgentApiKeyIssued> {
  return meAgentRequest<AgentApiKeyIssued>(
    apiBase,
    token,
    "POST",
    `/keys/${keyId}/rotate`,
  );
}

export function revokeAgentKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<void> {
  return meAgentRequest<void>(apiBase, token, "DELETE", `/keys/${keyId}`);
}

export function listAgentReceipts(
  apiBase: string,
  token: string,
  query = "",
): Promise<AgentReceiptList> {
  const qs = query ? `?${query}` : "";
  return meAgentRequest<AgentReceiptList>(apiBase, token, "GET", `/receipts${qs}`);
}

// --- Merchant ops (SIWE session on bare /v1/* paths) ----------------------
//
// The agent control plane lives under /v1/me/agent (see meAgentRequest).
// Merchant routes (/v1/links, /v1/payments, /v1/subscribers,
// /v1/merchant-profile) share the SAME xen_session cookie but sit at bare
// /v1/* paths, so they need a sibling request helper.

/**
 * Authenticated request against merchant routes. Sends the SIWE session as a
 * Cookie on a full `/v1/...` path. Throws {@link SessionExpiredError} on 401.
 */
export async function meSessionRequest<T>(
  apiBase: string,
  sessionToken: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new SessionExpiredError(await errorMessage(res));
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET /v1/links/schema — public, no auth. The create-body descriptor. */
export async function getLinkSchema(
  apiBase: string,
): Promise<PayLinkSchemaResponse> {
  const res = await fetch(`${apiBase}/v1/links/schema`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as PayLinkSchemaResponse;
}

/** POST /v1/links/validate — check a params tree before signing. */
export function validateLink(
  apiBase: string,
  token: string,
  params: Record<string, unknown>,
): Promise<PayLinkValidateResponse> {
  return meSessionRequest<PayLinkValidateResponse>(
    apiBase,
    token,
    "POST",
    "/v1/links/validate",
    { params },
  );
}

/** POST /v1/links — create a signed pay-link. Auto idempotency key. */
export function createLink(
  apiBase: string,
  token: string,
  body: PayLinkCreateBody,
  idempotencyKey: string,
): Promise<PayLinkCreateResponse> {
  return meSessionRequest<PayLinkCreateResponse>(
    apiBase,
    token,
    "POST",
    "/v1/links",
    body,
    { "Idempotency-Key": idempotencyKey },
  );
}

export function listLinks(
  apiBase: string,
  token: string,
  query = "",
): Promise<PayLinkListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<PayLinkListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/links${qs}`,
  );
}

export function getLinkDetail(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<PayLinkDetail> {
  return meSessionRequest<PayLinkDetail>(
    apiBase,
    token,
    "GET",
    `/v1/links/${encodeURIComponent(linkId)}`,
  );
}

export function revokeLink(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<PayLinkRevokeResponse> {
  return meSessionRequest<PayLinkRevokeResponse>(
    apiBase,
    token,
    "DELETE",
    `/v1/links/${encodeURIComponent(linkId)}`,
  );
}

export function listMerchantPayments(
  apiBase: string,
  token: string,
  query = "",
): Promise<MerchantPaymentListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<MerchantPaymentListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/payments/received${qs}`,
  );
}

export function listSubscribers(
  apiBase: string,
  token: string,
  query = "",
): Promise<SubscriberListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<SubscriberListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers${qs}`,
  );
}

/** GET /v1/merchant-profile — null if the merchant has none yet. */
export function getMerchantProfile(
  apiBase: string,
  token: string,
): Promise<MerchantProfileResponse | null> {
  return meSessionRequest<MerchantProfileResponse | null>(
    apiBase,
    token,
    "GET",
    "/v1/merchant-profile",
  );
}

export function putMerchantProfile(
  apiBase: string,
  token: string,
  body: MerchantProfileBody,
): Promise<MerchantProfileResponse> {
  return meSessionRequest<MerchantProfileResponse>(
    apiBase,
    token,
    "PUT",
    "/v1/merchant-profile",
    body,
  );
}

export function verifyMerchantDomain(
  apiBase: string,
  token: string,
): Promise<MerchantProfileResponse> {
  return meSessionRequest<MerchantProfileResponse>(
    apiBase,
    token,
    "POST",
    "/v1/merchant-profile/verify-domain",
  );
}

// --- wrapped pay-link payment (public x402 flow) --------------------------

/**
 * POST /v1/links/{id}/initiate — the x402 envelope for the gasless flow.
 * Returns HTTP 402 on SUCCESS (canonical x402), so 402 is parsed as the body.
 */
export async function initiateLinkPayment(
  apiBase: string,
  linkId: string,
): Promise<PayLinkInitiateResponse> {
  const res = await fetch(
    `${apiBase}/v1/links/${encodeURIComponent(linkId)}/initiate`,
    { method: "POST" },
  );
  if (res.status === 402 || res.ok) {
    return (await res.json()) as PayLinkInitiateResponse;
  }
  throw new Error(await errorMessage(res));
}

/** POST /v1/links/{id}/claim — record the on-chain tx against the link. */
export async function claimLinkPayment(
  apiBase: string,
  linkId: string,
  txHash: string,
): Promise<PayLinkClaimResponse> {
  const res = await fetch(
    `${apiBase}/v1/links/${encodeURIComponent(linkId)}/claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as PayLinkClaimResponse;
}
