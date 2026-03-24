import { ethers } from "ethers";
import { SignClient } from "@walletconnect/sign-client";
import { FileStorage } from "./wc-storage.js";
import type { Config, WalletConnectConfig } from "../types.js";

type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>;

const BASE_CHAIN_ID = "eip155:8453";
const BASE_SEPOLIA_CHAIN_ID = "eip155:84532";

export function getWcChainId(network: string): string {
  return network === "base-sepolia" ? BASE_SEPOLIA_CHAIN_ID : BASE_CHAIN_ID;
}

export async function initSignClient(projectId: string): Promise<SignClientInstance> {
  const storage = new FileStorage();

  const client = await SignClient.init({
    projectId,
    metadata: {
      name: "Xenarch CLI",
      description: "Pay for gated content from the command line",
      url: "https://xenarch.dev",
      icons: [],
    },
    storage: storage as any,
  });

  // Prune expired sessions to prevent stale-topic crashes
  try {
    const sessions = client.session.getAll();
    const now = Math.floor(Date.now() / 1000);
    for (const s of sessions) {
      if (s.expiry < now) {
        await client.disconnect({
          topic: s.topic,
          reason: { code: 6000, message: "Session expired" },
        }).catch(() => {});
      }
    }
  } catch {
    // Storage may be corrupt — clear it and re-init
    await storage.removeItem("wc@2:client:0.3//session");
  }

  return client;
}

/**
 * ethers v6 Signer backed by a WalletConnect session.
 * Transactions are signed remotely by the connected wallet app.
 */
export class WalletConnectSigner extends ethers.AbstractSigner<ethers.JsonRpcProvider> {
  private client: SignClientInstance;
  private sessionTopic: string;
  private chainId: string;
  private _address: string;

  constructor(
    client: SignClientInstance,
    sessionTopic: string,
    address: string,
    chainId: string,
    provider: ethers.JsonRpcProvider,
  ) {
    super(provider);
    this.client = client;
    this.sessionTopic = sessionTopic;
    this._address = address;
    this.chainId = chainId;
  }

  async getAddress(): Promise<string> {
    return this._address;
  }

  connect(provider: ethers.Provider): WalletConnectSigner {
    return new WalletConnectSigner(
      this.client,
      this.sessionTopic,
      this._address,
      this.chainId,
      provider as ethers.JsonRpcProvider,
    );
  }

  async signTransaction(_tx: ethers.TransactionRequest): Promise<string> {
    throw new Error(
      "WalletConnect wallets sign and broadcast in one step. Use sendTransaction() instead.",
    );
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const msg =
      typeof message === "string" ? message : ethers.hexlify(message);
    return this.client.request<string>({
      topic: this.sessionTopic,
      chainId: this.chainId,
      request: {
        method: "personal_sign",
        params: [msg, this._address],
      },
    });
  }

  async signTypedData(
    _domain: ethers.TypedDataDomain,
    _types: Record<string, ethers.TypedDataField[]>,
    _value: Record<string, unknown>,
  ): Promise<string> {
    throw new Error("signTypedData is not implemented for WalletConnect signer.");
  }

  async sendTransaction(
    tx: ethers.TransactionRequest,
  ): Promise<ethers.TransactionResponse> {
    const populated = await this.populateTransaction(tx);

    const txParams: Record<string, string> = {
      from: this._address,
      to: populated.to as string,
      data: (populated.data as string) ?? "0x",
    };

    if (populated.value != null && populated.value !== 0n) {
      txParams.value = ethers.toBeHex(populated.value);
    }

    // Remote wallet signs + broadcasts — returns tx hash
    const txHash: string = await this.client.request<string>({
      topic: this.sessionTopic,
      chainId: this.chainId,
      request: {
        method: "eth_sendTransaction",
        params: [txParams],
      },
    });

    // Poll until the provider sees the transaction
    const provider = this.provider!;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await provider.getTransaction(txHash);
      if (response) return response;
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(
      `Transaction ${txHash} was broadcast but not found by provider after 30 s. It may still be pending.`,
    );
  }
}

/**
 * Restore a WalletConnectSigner from saved config.
 * Throws if the session is missing or expired.
 */
export async function restoreWalletConnectSigner(
  config: Config,
  rpcUrl: string,
): Promise<WalletConnectSigner> {
  const wallet = config.wallet as WalletConnectConfig;
  const projectId = config.wc_project_id;

  if (!projectId) {
    throw new Error(
      "No WalletConnect Project ID configured. Run `xenarch wallet connect --project-id <ID>` first.",
    );
  }

  const client = await initSignClient(projectId);

  let session;
  try {
    session = client.session.get(wallet.session_topic);
  } catch {
    throw new Error(
      "WalletConnect session not found. Run `xenarch wallet connect` to reconnect.",
    );
  }

  if (session.expiry * 1000 < Date.now()) {
    throw new Error(
      "WalletConnect session has expired. Run `xenarch wallet connect` to reconnect.",
    );
  }

  const chainId = getWcChainId(config.network);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new WalletConnectSigner(
    client,
    wallet.session_topic,
    wallet.address,
    chainId,
    provider,
  );
}
