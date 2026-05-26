// Agent control plane preflight check (XEN-373 — Phase 3 of XEN-370).
//
// Unlike receipts (best-effort, fire-and-forget), preflight BLOCKS the
// pay flow. If the operator has configured this CLI install with
// XENARCH_API_TOKEN, every `xenarch pay` calls
// `POST /v1/agent/preflight` first. The platform decides:
//
//   - ok: true  → tool gets auth_token, settlement proceeds, the same
//                 token is forwarded on the receipt POST so the platform
//                 can prove this receipt belongs to a pre-approved pay.
//   - ok: false → tool refuses with the platform's reason (e.g.
//                 "denied by scope rule *.scammer.com").
//
// Fail-closed: control plane unreachable + token configured → refuse.
// No token configured → bypass (Phase-1 backwards compat).

const ENV_TOKEN = "XENARCH_API_TOKEN";
const PREFLIGHT_TIMEOUT_MS = 5000;

export interface PreflightMatchedRule {
  id?: string | null;
  pattern: string;
  mode: "allow" | "deny";
  label?: string | null;
}

export interface PreflightAllow {
  ok: true;
  auth_token: string;
  expires_in: number;
}

export interface PreflightDeny {
  ok: false;
  reason: string;
  matched_rule?: PreflightMatchedRule | null;
}

export interface PreflightUnreachable {
  ok: false;
  reason: "control_plane_unreachable";
  detail: string;
}

export interface PreflightBypassed {
  ok: true;
  auth_token: null;
  expires_in: 0;
  bypassed: true;
}

export type PreflightResult =
  | PreflightAllow
  | PreflightDeny
  | PreflightUnreachable
  | PreflightBypassed;

/**
 * Format a deny reason into a human-readable refusal message + a hint
 * pointing the operator at the dashboard surface where they can change
 * the relevant rule or kill state.
 */
export function formatDenyMessage(result: PreflightDeny): string {
  if (result.reason === "paused") {
    return [
      "Refused by Xenarch control plane: agent is paused.",
      "Toggle the kill switch off at https://dash.xenarch.dev/agent/scope",
    ].join("\n");
  }
  if (result.reason === "scope" && result.matched_rule) {
    const pattern = result.matched_rule.pattern;
    const label = result.matched_rule.label
      ? ` (“${result.matched_rule.label}”)`
      : "";
    return [
      `Refused by Xenarch control plane: scope rule '${pattern}'${label} matched this URL.`,
      "Edit rules at https://dash.xenarch.dev/agent/scope",
    ].join("\n");
  }
  return `Refused by Xenarch control plane: ${result.reason}`;
}

/**
 * Sync preflight call. Returns:
 *
 *  - {ok: true, auth_token, expires_in}  → proceed with payment.
 *  - {ok: true, auth_token: null, bypassed: true}  → no token configured,
 *    proceed without enforcement (Phase-1 backwards compat).
 *  - {ok: false, reason}  → refuse the payment with that reason.
 *  - {ok: false, reason: "control_plane_unreachable", detail}  → refuse
 *    (fail-closed — the operator configured a token, expects enforcement).
 *
 * Never throws. The pay command decides how to surface the result.
 */
export async function checkPreflight(
  apiBase: string,
  url: string,
  amountUsd: string,
): Promise<PreflightResult> {
  const token = process.env[ENV_TOKEN];
  if (!token) {
    return { ok: true, auth_token: null, expires_in: 0, bypassed: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/agent/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": token,
        "User-Agent": "xenarch-cli/0.3.0",
      },
      body: JSON.stringify({ url, amount_usd: amountUsd }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        ok: false,
        reason: "control_plane_unreachable",
        detail: "Token rejected (revoked or invalid). Re-issue at https://dash.xenarch.dev/agent/settings",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "control_plane_unreachable",
        detail: `Platform returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as PreflightResult;
    return body;
  } catch (err) {
    // Surface only the error kind, not the message — the message can
    // carry the request URL/body in some fetch implementations.
    const kind = (err as Error).name || "NetworkError";
    return {
      ok: false,
      reason: "control_plane_unreachable",
      detail: `${kind} reaching control plane`,
    };
  } finally {
    clearTimeout(timer);
  }
}
