/**
 * Minimal fetch helpers for the few endpoints `@xenarch/core` does not already
 * wrap. Two auth styles the core `meSessionRequest` (SIWE cookie) doesn't cover:
 *
 *   - `bearerRequest` — `Authorization: Bearer <token>`. Used by the usage
 *     ingestion endpoint, which authenticates with a pay-link's `webhook_secret`
 *     (not a merchant session).
 *   - `publicRequest` — no auth. Used by public reads (receipts, reputation,
 *     rates, whois).
 *
 * Error shape mirrors core: throw an `Error` whose message is the server's
 * `detail` when present.
 */

import { SESSION_COOKIE_NAME, SessionExpiredError } from "@xenarch/core";

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === "string") return body.detail;
    return JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** JSON request authenticated with a Bearer token (e.g. a link `webhook_secret`). */
export async function bearerRequest<T>(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/** Unauthenticated JSON GET (public read endpoints). */
export async function publicRequest<T>(
  apiBase: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/**
 * Multipart POST authenticated with the SIWE `xen_session` cookie. Used for
 * asset uploads. Deliberately does NOT set Content-Type — `fetch` derives the
 * multipart boundary from the `FormData` body.
 */
export async function sessionMultipart<T>(
  apiBase: string,
  sessionToken: string,
  path: string,
  form: FormData,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/**
 * GET returning the raw response body as text, authenticated with the SIWE
 * `xen_session` cookie. Used by the CSV export endpoints, which reply with
 * `text/csv` (not JSON) so the JSON helpers can't parse them.
 */
export async function sessionText(
  apiBase: string,
  sessionToken: string,
  path: string,
): Promise<string> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "GET",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  if (res.status === 401) throw new SessionExpiredError(await errorMessage(res));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.text();
}

/** snake_case query string from an options object; drops undefined/null. */
export function toQuery(opts: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== null) {
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}
