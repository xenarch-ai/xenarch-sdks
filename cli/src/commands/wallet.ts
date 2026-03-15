import { Command } from "commander";
import { ethers } from "ethers";
import { readConfig } from "../lib/config.js";
import {
  generateWallet,
  importWallet,
  saveWallet,
  getWalletConfig,
} from "../lib/wallet.js";
import { USDC_BASE, USDC_ABI } from "../types.js";
import { bold, green, yellow, cyan } from "../lib/output.js";
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
}
