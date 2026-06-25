// Wrapped pay-link payment: the Xenarch-rails counterpart to a pure-x402 gate
// pay. Reuses the same facilitator-settle primitive (executePayment) but sources
// the x402 envelope from POST /v1/links/{id}/initiate and finalizes with
// POST /v1/links/{id}/claim. Shared by `xenarch pay-link <id>` and the
// hosted-checkout auto-detect path in `xenarch pay <url>` (sdk-mcp-cli §12.7).

import { ethers } from "ethers";
import { executePayment } from "./payment.js";
import {
  initiateLinkPayment,
  claimLinkPayment,
  ClaimAwaitingConfirmationsError,
} from "./api.js";
import { loadSigner } from "./wallet.js";
import { connectWalletConnect } from "./wc-connect.js";
import { checkPreflight, formatDenyMessage } from "./agent-preflight.js";
import {
  type Config,
  type GateResponse,
  type PayLinkClaimResponse,
} from "../types.js";

/**
 * Load a signer able to sign the EIP-3009 transfer for a payment. WalletConnect
 * connects fresh in-process (a disk-restored WC session can't decrypt the
 * signature response — XEN-407); a local wallet signs directly.
 */
export async function loadPayerSigner(
  config: Config,
  rpcUrl: string,
  jsonOutput: boolean,
): Promise<ethers.Signer> {
  if (!config.wallet) {
    throw new Error(
      "No wallet configured. Run `xenarch wallet generate|import|connect`.",
    );
  }
  if (config.wallet.type === "walletconnect") {
    const conn = await connectWalletConnect(config, rpcUrl, { json: jsonOutput });
    return conn.signer;
  }
  return loadSigner(rpcUrl);
}

// 10 × 3s = 30s. Covers the tx indexing on Base (~2s blocks) AND a 202
// "awaiting confirmations" wait once REQUIRED_CONFIRMATIONS > 1 (XEN-574) —
// comfortably more than any realistic depth for the max-$1 payments this rail
// carries.
const CLAIM_RETRIES = 10;
const CLAIM_RETRY_DELAY_MS = 3000;

/** Only the "tx not indexed yet" case is worth retrying; revoked/expired/
 * underpaid/invalid-tx are terminal and should fail fast (the money already
 * moved — don't hang 18s mislabeling it). */
function isTransientClaimError(err: unknown): boolean {
  const m = ((err as Error)?.message ?? "").toLowerCase();
  return /not found|not yet|pending|unconfirmed|not confirmed|no transaction|try again|still/.test(
    m,
  );
}

export interface PayLinkFlowResult {
  tx_hash: string;
  facilitator: string;
  link_id: string;
  amount_usd: string;
  claim: PayLinkClaimResponse;
  /** Preflight auth_token (null if the control plane was bypassed). */
  auth_token: string | null;
}

/** Recognize a Xenarch hosted-checkout URL and pull out its link id (§12.7). */
export function hostedCheckoutLinkId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)xenarch\.(com|dev)$/.test(u.hostname)) return null;
    // pay.xenarch.com/l/<id>  (the hosted checkout path)
    const m = u.pathname.match(/^\/l\/([A-Za-z0-9]+)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pay a Xenarch pay-link end to end:
 *   1. POST /initiate → x402 envelope (price from the chosen accept).
 *   2. Settle EIP-3009 via a facilitator (executePayment).
 *   3. POST /claim with the tx hash — retried while the tx mines.
 */
export async function payLinkWrapped(
  apiBase: string,
  linkId: string,
  signer: ethers.Signer,
  opts: { maxPriceUsd: number },
): Promise<PayLinkFlowResult> {
  const env = await initiateLinkPayment(apiBase, linkId);
  if (env.error) throw new Error(env.error);
  if (!env.accepts.length) {
    throw new Error("Pay-link returned no payment options (open-amount links aren't payable from the CLI yet).");
  }

  const accept = env.accepts.find((a) => a.scheme === "exact") ?? env.accepts[0];
  const priceUsd = ethers.formatUnits(BigInt(accept.maxAmountRequired), 6);
  if (parseFloat(priceUsd) > opts.maxPriceUsd) {
    throw new Error(
      `Pay-link price $${priceUsd} exceeds max price $${opts.maxPriceUsd.toFixed(2)}. Use --max-price to raise it.`,
    );
  }

  // Agent control-plane preflight (XEN-373): gate the pay-link by the agent's
  // caps / scope / pause before settling — same enforcement gate-pay uses.
  // No-op unless XENARCH_API_TOKEN is configured (fail-closed if it is).
  const preflight = await checkPreflight(
    apiBase,
    `https://pay.xenarch.com/l/${linkId}`,
    priceUsd,
  );
  if (!preflight.ok) {
    // formatDenyMessage already prefixes "Refused by Xenarch control plane:";
    // only the unreachable (detail) case needs the prefix added.
    const reason =
      "detail" in preflight
        ? `Refused by Xenarch control plane: ${preflight.detail}`
        : formatDenyMessage(preflight);
    throw new Error(reason);
  }
  // XEN-480: preflight is allowed here (the !ok branch threw above).
  const authToken = preflight.auth_token;

  // Adapt the initiate envelope into the GateResponse shape executePayment
  // consumes. asset is the USDC contract (used for facilitator selection);
  // price_usd drives the signed transfer value.
  const gate: GateResponse = {
    xenarch: true,
    gate_id: env.link_id,
    price_usd: priceUsd,
    seller_wallet: accept.payTo,
    network: env.network,
    // Router filters by asset SYMBOL ("USDC"), not the contract address — the
    // accepts[] entry carries the contract for selectAccept.
    asset: env.asset,
    protocol: env.protocol,
    facilitators: env.facilitators,
    accepts: env.accepts,
    verify_url: "",
    expires: env.expires ?? new Date(Date.now() + 600_000).toISOString(),
  };

  const settle = await executePayment(gate, signer);

  // The tx is broadcast; /claim re-fetches it from Base RPC and confirms the
  // USDC Transfer. Retry while it mines (Base ~2s blocks).
  let lastErr: unknown;
  for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
    try {
      const claim = await claimLinkPayment(apiBase, linkId, settle.tx_hash);
      return {
        tx_hash: settle.tx_hash,
        facilitator: settle.facilitator,
        link_id: linkId,
        amount_usd: priceUsd,
        claim,
        auth_token: authToken,
      };
    } catch (err) {
      lastErr = err;
      // XEN-574: a 202 "awaiting confirmations" (tx mined, not yet at the
      // server's confirmation depth, nothing booked) is retryable like a
      // not-yet-indexed tx — keep polling rather than failing the settled
      // payment. Everything else terminal (revoked/expired/invalid tx) fails
      // fast; the tx already settled on-chain, so surface it immediately.
      const retryable =
        err instanceof ClaimAwaitingConfirmationsError ||
        isTransientClaimError(err);
      if (!retryable) {
        throw new Error(
          `Payment settled (tx ${settle.tx_hash}) but the link rejected it: ${(err as Error).message}`,
        );
      }
      if (attempt < CLAIM_RETRIES - 1) await sleep(CLAIM_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `Payment settled (tx ${settle.tx_hash}) but the link could not confirm it after retries: ${(lastErr as Error).message}`,
  );
}
