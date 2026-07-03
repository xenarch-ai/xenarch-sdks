import { Command } from "commander";
import {
  createMerchantKey,
  listMerchantKeys,
  rotateMerchantKey,
  revokeMerchantKey,
} from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
} from "../lib/cmd-common.js";
import { bold, green, red, yellow, dim, formatTable } from "../lib/output.js";

export function registerKeysCommands(program: Command): void {
  const keys = program
    .command("keys")
    .description("Merchant API keys (xm_live_*) for server integrations");

  // --- create -------------------------------------------------------------
  keys
    .command("create")
    .description("Issue a new merchant API key — plaintext shown once (Tier-2)")
    .option("--label <label>", "Human label for the key")
    .option("--confirm", "Confirm non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          "Issue a new merchant API key?",
          "create_merchant_key",
          opts,
        );
        if (!ok) return;
        const k = await createMerchantKey(apiBase, token, opts.label ?? null);
        if (jsonOutput) {
          console.log(JSON.stringify(k));
          return;
        }
        console.log(`${green("Key issued.")}
  ${bold("Key:")}   ${k.plaintext} ${dim("(shown once)")}
  ${bold("ID:")}    ${k.id}${k.label ? `\n  ${bold("Label:")} ${k.label}` : ""}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- list ---------------------------------------------------------------
  keys
    .command("list")
    .description("List your merchant API keys")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const list = await listMerchantKeys(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(list));
          return;
        }
        if (!list.length) {
          console.log(dim("No keys. Create one with `xenarch keys create`."));
          return;
        }
        console.log(
          formatTable(
            ["ID", "Label", "Preview", "Last used", "Status"],
            list.map((k) => [
              k.id,
              k.label ?? dim("—"),
              `xm_live_····${k.hash_preview}`,
              k.last_used_at ?? dim("never"),
              k.revoked_at ? red("revoked") : green("active"),
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- rotate -------------------------------------------------------------
  keys
    .command("rotate <id>")
    .description("Rotate a key — old one stops working, new plaintext once (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Rotate key ${id}? The current key stops working immediately.`,
          "rotate_merchant_key",
          opts,
        );
        if (!ok) return;
        const k = await rotateMerchantKey(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(k));
          return;
        }
        console.log(`${green("Key rotated.")}
  ${bold("Key:")} ${k.plaintext} ${dim("(shown once)")}
  ${yellow("Update your integration — the old key no longer works.")}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- revoke -------------------------------------------------------------
  keys
    .command("revoke <id>")
    .description("Revoke a merchant API key (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Revoke key ${id}? Any integration using it stops authenticating.`,
          "revoke_merchant_key",
          opts,
        );
        if (!ok) return;
        await revokeMerchantKey(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify({ revoked: true, id }));
          return;
        }
        console.log(`${green("Key revoked.")} ${id}`);
      } catch (err) {
        fail(err);
      }
    });
}
