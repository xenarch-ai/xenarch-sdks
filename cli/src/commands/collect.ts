import { Command } from "commander";
import { listPermitCollectable, listMeteredCollectable } from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail, microUsd } from "../lib/cmd-common.js";
import { bold, dim, formatTable } from "../lib/output.js";
import type { CollectableRow } from "../types.js";

export function registerCollectCommands(program: Command): void {
  const collect = program
    .command("collect")
    .description("Collectable subscription cycles (read-only bag)");

  // --- list ---------------------------------------------------------------
  // Read-only: Xenarch never submits the on-chain USDC.transferFrom. This
  // surfaces the permit + metered subscriptions due for collection, with the
  // (owner, spender, value) the seller's wallet needs to call transferFrom on.
  collect
    .command("list")
    .description("List permit + metered subscriptions due for collection")
    .option("--link-id <id>", "Filter by a subscription link")
    .option("--mode <mode>", "Filter to one bag: permit | metered")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        if (opts.mode && opts.mode !== "permit" && opts.mode !== "metered") {
          throw new Error("--mode must be 'permit' or 'metered'.");
        }
        const token = await loadSession();
        const qs = new URLSearchParams();
        if (opts.linkId) qs.set("link_id", opts.linkId);
        const query = qs.toString();

        const wantPermit = !opts.mode || opts.mode === "permit";
        const wantMetered = !opts.mode || opts.mode === "metered";
        const [permit, metered] = await Promise.all([
          wantPermit ? listPermitCollectable(apiBase, token, query) : Promise.resolve(null),
          wantMetered ? listMeteredCollectable(apiBase, token, query) : Promise.resolve(null),
        ]);

        if (jsonOutput) {
          console.log(JSON.stringify({ permit, metered }));
          return;
        }

        const rows: Array<[string, CollectableRow]> = [
          ...(permit?.collectable ?? []).map((r) => ["permit", r] as [string, CollectableRow]),
          ...(metered?.collectable ?? []).map((r) => ["metered", r] as [string, CollectableRow]),
        ];
        if (!rows.length) {
          console.log(dim("Nothing collectable right now."));
          return;
        }
        console.log(
          formatTable(
            ["Subscriber", "Bag", "Link", "Payer", "Amount", "Owner → Spender"],
            rows.map(([bag, r]) => [
              r.subscription_id.slice(0, 12),
              bag,
              r.pay_link_id,
              r.payer_email ?? (r.payer_wallet ? `${r.payer_wallet.slice(0, 10)}…` : dim("—")),
              microUsd(r.transfer_from?.value ?? 0),
              `${(r.transfer_from?.owner ?? "—").slice(0, 8)}… → ${(r.transfer_from?.spender ?? "—").slice(0, 8)}…`,
            ]),
          ),
        );
        const total = (permit?.total_micro ?? 0) + (metered?.total_micro ?? 0);
        console.log(`${bold("Total collectable:")} ${microUsd(total)}`);
        console.log(
          dim("Collect on-chain from the seller wallet (USDC.transferFrom), then record it. `collect permit`/`collect metered` land in a follow-up."),
        );
      } catch (err) {
        fail(err);
      }
    });
}
