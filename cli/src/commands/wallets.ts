import { Command } from "commander";
import { listWallets, unlinkWallet, setWalletLabel, transferOwner } from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
} from "../lib/cmd-common.js";
import { bold, green, yellow, dim, formatTable } from "../lib/output.js";

export function registerWalletsCommands(program: Command): void {
  const wallets = program
    .command("wallets")
    .description("Linked account wallets (list, unlink, label, owner-transfer)");

  // Note: `wallets link` (SIWE-sign a new wallet) + `invite redeem` land in a
  // follow-up — they need a loaded signer + live wallet validation.

  // --- list ---------------------------------------------------------------
  wallets
    .command("list")
    .description("List wallets linked to your account")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const res = await listWallets(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.wallets.length) {
          console.log(dim("No linked wallets."));
          return;
        }
        console.log(
          formatTable(
            ["Address", "Label", "Role", "Payout", "Eligible"],
            res.wallets.map((w) => [
              w.address,
              w.label ?? dim("—"),
              w.is_owner ? green("owner") : w.is_primary ? "primary" : "member",
              w.is_default ? green("default") : dim("—"),
              w.eligible ? green("yes") : yellow(`at ${w.eligible_at}`),
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- unlink -------------------------------------------------------------
  wallets
    .command("unlink <address>")
    .description("Remove a linked wallet from your account (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (address: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Unlink wallet ${address} from your account?`,
          "unlink_wallet",
          opts,
        );
        if (!ok) return;
        await unlinkWallet(apiBase, token, address);
        if (jsonOutput) {
          console.log(JSON.stringify({ unlinked: true, address }));
          return;
        }
        console.log(`${green("Wallet unlinked.")} ${address}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- label --------------------------------------------------------------
  wallets
    .command("label <address> <label>")
    .description("Set a wallet's nickname (label 'none' clears it)")
    .action(async (address: string, label: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const value = label === "none" || label === "" ? null : label;
        await setWalletLabel(apiBase, token, address, value);
        if (jsonOutput) {
          console.log(JSON.stringify({ address, label: value }));
          return;
        }
        console.log(`${green("Label set.")} ${address} → ${value ?? dim("(cleared)")}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- owner (transfer the account owner anchor) --------------------------
  wallets
    .command("owner <new-owner>")
    .description("Transfer account ownership to another linked wallet (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (newOwner: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Transfer account ownership to ${newOwner}? ${bold("This hands over control of the account.")}`,
          "transfer_owner",
          opts,
        );
        if (!ok) return;
        const r = await transferOwner(apiBase, token, newOwner);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Ownership transferred.")} New owner: ${r.owner_wallet}`);
      } catch (err) {
        fail(err);
      }
    });
}
