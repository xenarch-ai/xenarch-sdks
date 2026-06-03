// In-process WalletConnect connect+sign for `xenarch agent login`.
//
// Why this exists (XEN-407): restoring a WalletConnect v2 session from disk in
// a *separate* CLI process and then signing fails — the inbound relay message
// (the signature) can't be decrypted because WC's in-memory crypto keychain
// isn't reconstituted intact across processes ("failed to process an inbound
// message"). The reliable path is to pair AND sign within the SAME process, so
// the client that holds the live keychain is the one that requests the
// signature. That's exactly how a browser dapp uses WC.
//
// We also wipe the WC store before pairing so stale sessions from earlier
// attempts can't collide on relay topics / keys.

import { ethers } from "ethers";
import { initSignClient, WalletConnectSigner, getWcChainId } from "./signer.js";
import { clearWcStorage } from "./wc-storage.js";
import { dim } from "./output.js";
import type { Config } from "../types.js";

export interface WcConnection {
  signer: WalletConnectSigner;
  address: string;
  sessionTopic: string;
}

/**
 * Pair a wallet via a QR code and return a live signer backed by the same
 * in-process client. The caller should immediately use the signer (e.g. for
 * SIWE) before the process exits — the session is not meant to be restored
 * later (see module docstring).
 */
export async function connectWalletConnect(
  config: Config,
  rpcUrl: string,
  opts: { json?: boolean } = {},
): Promise<WcConnection> {
  const projectId = config.wc_project_id;
  if (!projectId) {
    throw new Error(
      "No WalletConnect Project ID configured. Run `xenarch wallet connect --project-id <ID>` once to set it.",
    );
  }

  // Clean slate: drop any stale sessions/keys so a fresh pairing can't collide.
  await clearWcStorage();

  const client = await initSignClient(projectId);
  const chainId = getWcChainId(config.network);

  const { uri, approval } = await client.connect({
    optionalNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign"],
        chains: [chainId],
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });
  if (!uri) throw new Error("Failed to generate WalletConnect pairing URI.");

  if (!opts.json) {
    console.log("Scan this QR code with your wallet app:\n");
    // Dynamic import — qrcode-terminal is CJS (typed via src/qrcode-terminal.d.ts).
    const qrcode = await import("qrcode-terminal");
    const mod = qrcode.default ?? qrcode;
    if (mod.setErrorLevel) mod.setErrorLevel("L");
    mod.generate(uri, { small: true });
    console.log(`\n  Or copy this URI: ${dim(uri)}\n`);
    console.log("Waiting for wallet approval (connect), then a signature request…");
  }

  // Suppress benign stale-relay noise ("No matching key") from old pairings.
  const onUncaught = (err: Error) => {
    if (err.message?.includes("No matching key")) return;
    throw err;
  };
  process.on("uncaughtException", onUncaught);

  let session;
  try {
    session = await approval();
  } finally {
    process.removeListener("uncaughtException", onUncaught);
  }

  const accounts =
    session.namespaces.eip155?.accounts ??
    Object.values(session.namespaces).flatMap((ns: any) => ns.accounts);
  if (!accounts.length) throw new Error("No accounts returned from wallet.");
  // Account format: "eip155:<chainId>:<address>"
  const address = accounts[0].split(":")[2];

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new WalletConnectSigner(
    client,
    session.topic,
    address,
    chainId,
    provider,
  );
  return { signer, address, sessionTopic: session.topic };
}
