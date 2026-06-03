// SIWE (Sign-In With Ethereum, EIP-4361) session establishment for the CLI.
//
// The agent control plane (`/v1/me/agent/*`) is authed by a SIWE wallet
// session cookie (`xen_session`), NOT the publisher Bearer key or the
// `xa_live_*` agent key. This module turns the wallet the CLI already has
// connected (local or WalletConnect) into such a session:
//
//   nonce  → POST /v1/auth/siwe/nonce
//   sign   → personal_sign the EIP-4361 message with the connected wallet
//   verify → POST /v1/auth/siwe/verify (server sets the xen_session cookie)
//
// The platform's verifier (app/services/siwe_auth.py) requires:
//   - domain ∈ SIWE_ALLOWED_DOMAINS  → "dash.xenarch.dev"
//   - chain_id == SIWE_REQUIRED_CHAIN_ID → 8453 (Base mainnet)
//   - a single-use, unexpired nonce
//   - an issued_at within the allowed window
// All of which the values below satisfy as-is — no platform change.

import { ethers } from "ethers";
import { siweNonce, siweVerify } from "./api.js";

// Must be one of the platform's SIWE_ALLOWED_DOMAINS. The CLI authenticates
// against the same backend as the dashboard, so it signs in under the same
// domain claim. The wallet shows this domain on the signature prompt.
const SIWE_DOMAIN = "dash.xenarch.dev";
const SIWE_URI = "https://dash.xenarch.dev";
const SIWE_STATEMENT =
  "Sign in to the Xenarch agent control plane from the CLI.";
const SIWE_CHAIN_ID = 8453; // Base mainnet — must match SIWE_REQUIRED_CHAIN_ID.
// Session lifetime requested in the message. The platform mints the session
// JWT off the message's Expiration Time, so this is the effective TTL.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EstablishedSession {
  /** Raw `xen_session` cookie value to replay on /me/agent/* requests. */
  token: string;
  /** ISO 8601 expiry (mirrors the message Expiration Time). */
  expiresAt: string;
  /** Checksummed wallet that signed in. */
  address: string;
}

/**
 * Build a canonical EIP-4361 message string.
 *
 * Follows the ABNF the `siwe` Python library parses: a domain preamble,
 * the checksummed address, a blank line, the statement, a blank line, then
 * the key/value field block. `address` is checksummed here because siwe-py
 * rejects non-EIP-55 addresses in the message body.
 */
export function buildSiweMessage(opts: {
  address: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  domain?: string;
  uri?: string;
  statement?: string;
  chainId?: number;
}): string {
  const address = ethers.getAddress(opts.address); // EIP-55 checksum
  const domain = opts.domain ?? SIWE_DOMAIN;
  const uri = opts.uri ?? SIWE_URI;
  const statement = opts.statement ?? SIWE_STATEMENT;
  const chainId = opts.chainId ?? SIWE_CHAIN_ID;

  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
    `Expiration Time: ${opts.expirationTime}`,
  ].join("\n");
}

/**
 * Run the full SIWE handshake and return the session cookie.
 *
 * `signer` is whatever `loadSigner()` returned — a local `ethers.Wallet`
 * or a `WalletConnectSigner`. We sign the message as UTF-8 *bytes* so both
 * paths produce a standard EIP-191 signature: the WC signer hex-encodes the
 * bytes for `personal_sign`, and a local wallet signs the same bytes
 * directly. Either way siwe-py recovers the signer from the UTF-8 message.
 */
export async function establishSession(
  apiBase: string,
  signer: ethers.Signer,
): Promise<EstablishedSession> {
  const address = ethers.getAddress(await signer.getAddress());

  const issued = await siweNonce(apiBase);
  const issuedAt = issued.issued_at; // server's clock — sidesteps skew
  const expirationTime = new Date(
    Date.parse(issuedAt) + SESSION_TTL_MS,
  ).toISOString();

  const message = buildSiweMessage({
    address,
    nonce: issued.nonce,
    issuedAt,
    expirationTime,
  });

  // UTF-8 bytes → standard EIP-191 across both signer types (see docstring).
  const signature = await signer.signMessage(ethers.toUtf8Bytes(message));

  const { token } = await siweVerify(apiBase, message, signature);
  return { token, expiresAt: expirationTime, address };
}
