import { Command } from "commander";
import { ethers } from "ethers";
import { readConfig, writeConfig } from "../lib/config.js";
import {
  generateWallet,
  importWallet,
  saveWallet,
  getWalletConfig,
} from "../lib/wallet.js";
import { initSignClient, getWcChainId } from "../lib/signer.js";
import { clearWcStorage } from "../lib/wc-storage.js";
import { fetchPlatformConfig } from "../lib/api.js";
import { USDC_BASE, USDC_ABI } from "../types.js";
import { bold, green, yellow, cyan, dim } from "../lib/output.js";
import * as readline from "node:readline";

function getGlobalOpts(cmd: Command): { json: boolean; rpcUrl?: string } {
  const root = cmd.optsWithGlobals();
  return { json: root.json ?? false, rpcUrl: root.rpcUrl };
}

async function confirmOverwrite(address: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(
      `Wallet already configured (${address}). Overwrite? [y/N] `,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y");
      },
    );
  });
}

export function registerWalletCommands(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("Manage wallet keypair");

  wallet
    .command("generate")
    .description("Generate a new Base wallet keypair")
    .action(async (_opts, cmd) => {
      const { json } = getGlobalOpts(cmd);
      const existing = await getWalletConfig();
      if (existing) {
        const ok = await confirmOverwrite(existing.address);
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      const w = generateWallet();
      await saveWallet(w);

      if (json) {
        console.log(JSON.stringify({ address: w.address, private_key: w.privateKey }));
        return;
      }

      console.log(`${green("Wallet generated.")}

  ${bold("Address:")}     ${w.address}
  ${bold("Private key:")} ${w.privateKey}

  ${yellow("IMPORTANT:")} Back up your private key. It is stored in ~/.xenarch/config.json
  and will not be shown again.

  Fund your wallet by sending USDC (Base) to: ${cyan(w.address)}`);
    });

  wallet
    .command("import")
    .description("Import an existing private key")
    .option("--private-key <key>", "Private key (0x-prefixed hex)")
    .action(async (opts, cmd) => {
      const { json } = getGlobalOpts(cmd);
      let privateKey: string = opts.privateKey;

      if (!privateKey) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        privateKey = await new Promise((resolve) => {
          rl.question("Enter private key: ", (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      }

      const existing = await getWalletConfig();
      if (existing) {
        const ok = await confirmOverwrite(existing.address);
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      const w = importWallet(privateKey);
      await saveWallet(w);

      if (json) {
        console.log(JSON.stringify({ address: w.address }));
        return;
      }

      console.log(`${green("Wallet imported.")}

  ${bold("Address:")} ${w.address}`);
    });

  wallet
    .command("balance")
    .description("Check USDC and ETH balance")
    .action(async (_opts, cmd) => {
      const { json, rpcUrl } = getGlobalOpts(cmd);
      const config = await readConfig();

      if (!config.wallet) {
        console.error(
          "No wallet configured. Run `xenarch wallet generate` or `xenarch wallet import` first.",
        );
        process.exitCode = 1;
        return;
      }

      const rpc = rpcUrl ?? config.rpc_url;
      const provider = new ethers.JsonRpcProvider(rpc);
      const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, provider);

      const [ethBalance, usdcBalance] = await Promise.all([
        provider.getBalance(config.wallet.address),
        usdc.balanceOf(config.wallet.address) as Promise<bigint>,
      ]);

      const ethFormatted = ethers.formatEther(ethBalance);
      const usdcFormatted = ethers.formatUnits(usdcBalance, 6);

      if (json) {
        console.log(
          JSON.stringify({
            address: config.wallet.address,
            usdc: usdcFormatted,
            eth: ethFormatted,
          }),
        );
        return;
      }

      console.log(`Wallet: ${cyan(config.wallet.address)}

  ${bold("USDC (Base):")}  ${usdcFormatted}
  ${bold("ETH  (Base):")}  ${ethFormatted} (for gas)`);
    });

  wallet
    .command("connect")
    .description("Connect a remote wallet via WalletConnect")
    .option("--project-id <id>", "Reown Project ID (from cloud.reown.com)")
    .action(async (opts, cmd) => {
      const { json } = getGlobalOpts(cmd);

      try {
        // Resolve project ID: flag > API > cached config
        const config = await readConfig();
        let projectId: string | undefined = opts.projectId;

        if (!projectId) {
          // Try fetching from the platform API
          try {
            const platformConfig = await fetchPlatformConfig(config.api_base);
            if (platformConfig.wc_project_id) {
              projectId = platformConfig.wc_project_id;
            }
          } catch {
            // API unreachable — fall back to cached value
          }
        }

        if (!projectId) {
          projectId = config.wc_project_id ?? undefined;
        }

        if (!projectId) {
          console.error(
            "Could not retrieve WalletConnect configuration from Xenarch API.\n" +
              "Check your connection or override with: xenarch wallet connect --project-id <ID>",
          );
          process.exitCode = 1;
          return;
        }

        // Confirm overwrite if wallet already configured
        const existing = await getWalletConfig();
        if (existing) {
          const ok = await confirmOverwrite(existing.address);
          if (!ok) {
            console.log("Aborted.");
            return;
          }
        }

        // Initialize WalletConnect
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

        if (!uri) {
          throw new Error("Failed to generate WalletConnect pairing URI.");
        }

        // Display QR code in terminal
        if (!json) {
          console.log("Scan this QR code with your wallet app:\n");

          // Dynamic import — qrcode-terminal is CJS with no types
          const qrcode = await import("qrcode-terminal");
          const mod = qrcode.default ?? qrcode;
          // Low error correction to handle long WC URIs
          if (mod.setErrorLevel) mod.setErrorLevel("L");
          mod.generate(uri, { small: true });

          console.log(`\n  Or copy this URI: ${dim(uri)}\n`);
          console.log("Waiting for connection...");
        }

        // Suppress WC internal errors for stale relay messages
        // (e.g. session_update for topics from previous pairings)
        const onUncaught = (err: Error) => {
          if (err.message?.includes("No matching key")) return;
          throw err;
        };
        process.on("uncaughtException", onUncaught);

        // Block until the user approves in their wallet app
        let session;
        try {
          session = await approval();
        } finally {
          process.removeListener("uncaughtException", onUncaught);
        }

        // Extract account address from session namespaces
        const accounts =
          session.namespaces.eip155?.accounts ??
          Object.values(session.namespaces).flatMap((ns: any) => ns.accounts);

        if (accounts.length === 0) {
          throw new Error("No accounts returned from wallet.");
        }

        // Account format: "eip155:<chainId>:<address>"
        const address = accounts[0].split(":")[2];
        const walletName = session.peer?.metadata?.name ?? "Unknown Wallet";

        // Persist to config
        config.wc_project_id = projectId;
        config.wallet = {
          type: "walletconnect",
          address,
          session_topic: session.topic,
          relay_url: session.relay?.protocol ?? "irn",
        };
        await writeConfig(config);

        if (json) {
          console.log(
            JSON.stringify({
              address,
              wallet_name: walletName,
              session_topic: session.topic,
            }),
          );
          return;
        }

        const expiryDays = Math.round(
          (session.expiry - Date.now() / 1000) / 86400,
        );
        console.log(
          `\n${green("Connected!")} Address: ${cyan(address)} (via ${walletName})`,
        );
        console.log(`Session saved. Expires in ${expiryDays} days.`);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("rejected") || msg.includes("denied")) {
          console.error("Connection rejected by wallet.");
        } else {
          console.error(`WalletConnect error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  wallet
    .command("disconnect")
    .description("Disconnect WalletConnect wallet")
    .action(async (_opts, cmd) => {
      const { json } = getGlobalOpts(cmd);
      const config = await readConfig();

      if (!config.wallet || config.wallet.type !== "walletconnect") {
        console.error("No WalletConnect wallet to disconnect.");
        process.exitCode = 1;
        return;
      }

      const address = config.wallet.address;

      // Best-effort: tell the remote wallet we're disconnecting
      if (config.wc_project_id) {
        try {
          const client = await initSignClient(config.wc_project_id);
          await client.disconnect({
            topic: config.wallet.session_topic,
            reason: { code: 6000, message: "User disconnected" },
          });
        } catch {
          // Session may already be expired — that's fine
        }
      }

      config.wallet = null;
      await writeConfig(config);

      // Clear WC storage to prevent stale pairing data from crashing next connect
      await clearWcStorage();

      if (json) {
        console.log(JSON.stringify({ disconnected: true, address }));
        return;
      }

      console.log(`${green("Disconnected")} wallet ${address}.`);
    });
}
