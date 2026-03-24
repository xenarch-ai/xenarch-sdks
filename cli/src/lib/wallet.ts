import { ethers } from "ethers";
import { readConfig, writeConfig } from "./config.js";
import { restoreWalletConnectSigner } from "./signer.js";
import type { WalletConfig, LocalWalletConfig } from "../types.js";

export interface GeneratedWallet {
  address: string;
  privateKey: string;
}

export function generateWallet(): GeneratedWallet {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export function importWallet(privateKey: string): GeneratedWallet {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      "Invalid private key format. Must be a 0x-prefixed 64-character hex string.",
    );
  }
  const wallet = new ethers.Wallet(privateKey);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export async function saveWallet(
  walletData: GeneratedWallet,
  configDir?: string,
): Promise<void> {
  const config = await readConfig(configDir);
  config.wallet = {
    type: "local",
    address: walletData.address,
    private_key: walletData.privateKey,
  };
  await writeConfig(config, configDir);
}

export async function loadWallet(configDir?: string): Promise<ethers.Wallet> {
  const config = await readConfig(configDir);
  if (!config.wallet) {
    throw new Error(
      "No wallet configured. Run `xenarch wallet generate`, `xenarch wallet import`, or `xenarch wallet connect` first.",
    );
  }
  if (config.wallet.type === "walletconnect") {
    throw new Error(
      "Current wallet is WalletConnect — local signing not available. Use `xenarch pay` which handles WalletConnect automatically.",
    );
  }
  return new ethers.Wallet(config.wallet.private_key);
}

export async function getWalletConfig(
  configDir?: string,
): Promise<WalletConfig | null> {
  const config = await readConfig(configDir);
  return config.wallet;
}

/**
 * Load an ethers Signer for the configured wallet.
 * - Local wallet: returns ethers.Wallet connected to provider
 * - WalletConnect: restores the WC session and returns a WalletConnectSigner
 */
export async function loadSigner(
  rpcUrl: string,
  configDir?: string,
): Promise<ethers.Signer> {
  const config = await readConfig(configDir);
  if (!config.wallet) {
    throw new Error(
      "No wallet configured. Run `xenarch wallet generate`, `xenarch wallet import`, or `xenarch wallet connect` first.",
    );
  }

  if (config.wallet.type === "local") {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    return new ethers.Wallet(config.wallet.private_key, provider);
  }

  // WalletConnect
  return restoreWalletConnectSigner(config, rpcUrl);
}
