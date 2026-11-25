import type { LinkNetworksChoice } from "../types.js";

/**
 * Parse `--set base:USDC,ethereum:USDC+USDT,tron:USDT` into the
 * `PUT /v1/links/:id/networks` body. A network may also repeat
 * (`ethereum:USDC,ethereum:USDT`). Base USDC is always on, so a `base`
 * entry is accepted and dropped. Tron (any network that pays its own
 * address) takes `pay_to` from `--tron-address`. `none` = Base USDC only.
 */
export function parseNetworkSpec(
  spec: string,
  tronAddress?: string,
): LinkNetworksChoice {
  const out: LinkNetworksChoice = {};
  const trimmed = spec.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return out;
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const [rawNet, rawCoins] = item.split(":");
    const net = (rawNet ?? "").trim().toLowerCase();
    if (!net || rawCoins === undefined || !rawCoins.trim()) {
      throw new Error(`bad network entry "${item}": use network:COIN, e.g. ethereum:USDC`);
    }
    const coins = rawCoins
      .split("+")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (net === "base") continue; // always on, USDC only
    const entry = out[net] ?? { tokens: [] };
    for (const c of coins) if (!entry.tokens.includes(c)) entry.tokens.push(c);
    out[net] = entry;
  }
  if (out.tron) {
    if (!tronAddress) {
      throw new Error("tron needs --tron-address <T…> (the store's Tron receiving address)");
    }
    out.tron.pay_to = tronAddress.trim();
  } else if (tronAddress) {
    throw new Error("--tron-address only applies when --set includes tron (e.g. tron:USDT)");
  }
  return out;
}

