import { Command } from "commander";
import * as readline from "node:readline";
import { readConfig } from "../lib/config.js";
import { updatePayout } from "../lib/api.js";
import { bold, green, yellow } from "../lib/output.js";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function isValidWallet(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function registerPayoutCommand(program: Command): void {
  const payout = program
    .command("payout")
    .description("Manage payout settings");

  payout
    .command("set")
    .description("Set your payout wallet address")
    .argument("<wallet>", "Wallet address (0x-prefixed, 40 hex chars)")
    .option("--network <network>", "Payout network", "base")
    .action(async (wallet: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const jsonOutput: boolean = globals.json ?? false;
      const config = await readConfig();
      const apiBase: string = globals.apiBase ?? config.api_base;
      const network: string = opts.network;

      if (!config.auth_token) {
        console.error(
          "Not authenticated. Run `xenarch register` first.",
        );
        process.exitCode = 1;
        return;
      }

      if (!isValidWallet(wallet)) {
        console.error("Invalid wallet address. Must be a 0x-prefixed 40-character hex string.");
        process.exitCode = 1;
        return;
      }

      // Prompt for password confirmation
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const password = await prompt(rl, "Confirm password: ");
      rl.close();

      if (!password) {
        console.error("Password is required to update payout wallet.");
        process.exitCode = 1;
        return;
      }

      try {
        const result = await updatePayout(
          apiBase,
          config.auth_token,
          wallet,
          password,
          network,
        );

        if (jsonOutput) {
          console.log(
            JSON.stringify({ confirmed: result.confirmed, effective_at: result.effective_at }),
          );
          return;
        }

        console.log(`${green("Payout wallet update confirmed.")}

  ${bold("Wallet:")}       ${wallet}
  ${bold("Network:")}      ${network}
  ${bold("Effective at:")} ${result.effective_at}

  ${yellow("NOTE:")} There is a 48-hour delay before the new wallet takes effect.`);
      } catch (err) {
        console.error(`Failed to update payout: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
