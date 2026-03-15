import { ethers } from "ethers";
import { readConfig, writeConfig } from "./config.js";
import type { WalletConfig } from "../types.js";

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
    address: walletData.address,
    private_key: walletData.privateKey,
  };
  await writeConfig(config, configDir);
}

export async function loadWallet(configDir?: string): Promise<ethers.Wallet> {
  const config = await readConfig(configDir);
  if (!config.wallet) {
    throw new Error(
      "No wallet configured. Run `xenarch wallet generate` or `xenarch wallet import` first.",
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
