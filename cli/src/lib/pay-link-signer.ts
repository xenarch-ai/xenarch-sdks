// Client-side `signed_params` for pay-link creation.
//
// Implements Information/design/signed-params-spec.md, matching the platform
// reference (xenarch-platform/app/services/signed_params.py) byte-for-byte. The
// platform re-verifies the signature on every render of pay.xenarch.com/l/<id>,
// so any divergence here makes the hosted checkout refuse to render the link.
//
// Canonicalization caveat: the platform's `canonical_json` is a JCS *subset*
// — Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)`
// — NOT full RFC-8785 (they diverge on number formatting). The server recomputes
// templateHash from the SAME `params` we POST, so the only requirement is that
// `canonicalJson` here produces the same bytes Python would for that object. Keep
// every `params` value STRING-valued (amount is a string per the spec) and the
// two encoders agree; a raw JS number is the one place they could drift.

import { ethers } from "ethers";

// EIP-712 domain — must equal signed_params.py exactly.
const DOMAIN: ethers.TypedDataDomain = {
  name: "Xenarch Pay Links",
  version: "1",
  chainId: 8453, // Base mainnet; the only chain a "base" link resolves to at MVP
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const PAY_LINK_TYPES: Record<string, ethers.TypedDataField[]> = {
  PayLink: [
    { name: "to", type: "address" },
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "network", type: "string" },
    { name: "kind", type: "string" },
    { name: "templateHash", type: "bytes32" },
    { name: "createdAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Compare two strings by Unicode code point — Python's `sort_keys` order.
 * JS's default `.sort()` orders by UTF-16 code unit, which diverges from
 * Python for astral-plane (surrogate-pair) keys; this matches Python. */
function compareByCodePoint(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const ca = aa[i].codePointAt(0)!;
    const cb = bb[i].codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return aa.length - bb.length;
}

/** Recursively sort object keys; arrays keep order. Mirrors Python sort_keys. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const src = value as Record<string, unknown>;
    for (const key of Object.keys(src).sort(compareByCodePoint)) {
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/** Recursively coerce JS numbers to strings so canonical JSON matches Python.
 * JS `JSON.stringify` and Python `json.dumps` serialize numbers differently
 * (1.0→"1" vs "1.0", exponents, precision) — a number in `params` would make
 * the client templateHash diverge from the server's, 403-ing every render. The
 * spec mandates string-valued params; this enforces it (bools/null serialize
 * identically in both, so they pass through). */
export function stringifyNumbers(value: unknown): unknown {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(stringifyNumbers);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stringifyNumbers(v);
    }
    return out;
  }
  return value;
}

/** JCS-subset canonical JSON string (see file header for the parity caveat). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** keccak256 of the canonical-JSON bytes of the params tree → 32-byte hex. */
export function computeTemplateHash(params: Record<string, unknown>): string {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(params)));
}

/** The five lit fields pulled into the EIP-712 message for wallet display. */
export interface PayLinkLit {
  to: string;
  amount: string;
  currency: string;
  network: string;
  kind: string;
}

export interface SignedPayLink {
  /** 65-byte ECDSA signature, 0x + 130 hex. */
  signed_params: string;
  /** 32-byte hex nonce, client-generated, POSTed verbatim. */
  nonce: string;
  /** UNIX seconds at signing, POSTed verbatim (server clamps ±5 min). */
  created_at: number;
}

/** Build the EIP-712 typed data for a pay-link template. */
export function buildPayLinkTypedData(opts: {
  lit: PayLinkLit;
  templateHash: string;
  createdAt: number;
  nonce: string;
}): {
  domain: ethers.TypedDataDomain;
  types: Record<string, ethers.TypedDataField[]>;
  message: Record<string, unknown>;
} {
  if (opts.lit.network !== "base") {
    throw new Error(
      `Unsupported network for signing: ${opts.lit.network} (only "base" at MVP).`,
    );
  }
  return {
    domain: DOMAIN,
    types: PAY_LINK_TYPES,
    message: {
      to: ethers.getAddress(opts.lit.to),
      amount: opts.lit.amount,
      currency: opts.lit.currency,
      network: opts.lit.network,
      kind: opts.lit.kind,
      templateHash: opts.templateHash,
      createdAt: opts.createdAt,
      nonce: opts.nonce,
    },
  };
}

/**
 * Sign a pay-link template: compute templateHash from `params`, generate the
 * nonce + createdAt, build the EIP-712 payload, and sign with the wallet.
 * Works for a local ethers.Wallet and the WalletConnectSigner (which implements
 * signTypedData via eth_signTypedData_v4).
 */
export async function signPayLink(
  signer: ethers.Signer,
  params: Record<string, unknown>,
  lit: PayLinkLit,
): Promise<SignedPayLink> {
  const templateHash = computeTemplateHash(params);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const createdAt = Math.floor(Date.now() / 1000);
  const typed = buildPayLinkTypedData({ lit, templateHash, createdAt, nonce });
  const signed_params = await signer.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  return { signed_params, nonce, created_at: createdAt };
}
