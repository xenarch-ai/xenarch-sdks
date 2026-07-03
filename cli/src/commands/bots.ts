import { Command } from "commander";
import { getBotCatalog, getBotActivity } from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail } from "../lib/cmd-common.js";
import { bold, dim, formatTable } from "../lib/output.js";

export function registerBotsCommands(program: Command): void {
  const bots = program
    .command("bots")
    .description("Bot catalog and cross-site bot activity")
    // `xenarch bots` with no subcommand lists the catalog.
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const res = await getBotCatalog(apiBase);
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        console.log(`${bold("Bot catalog")} ${dim(`(${res.count} signatures, ${res.categories.length} categories)`)}`);
        console.log(
          formatTable(
            ["Company", "Signature", "Category"],
            res.signatures.map((s) => [s.company, s.name, s.category]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- activity -----------------------------------------------------------
  bots
    .command("activity")
    .description("Aggregated cross-site bot activity for your sites")
    .option("--days <n>", "Look-back window in days (1-365)", "30")
    .option("--limit <n>", "Max signatures (1-500)", "100")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        qs.set("days", opts.days);
        qs.set("limit", opts.limit);
        const res = await getBotActivity(apiBase, token, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.activity.length) {
          console.log(dim(`No bot activity in the last ${res.window_days} days.`));
          return;
        }
        console.log(`${bold("Bot activity")} ${dim(`(last ${res.window_days}d, ${res.total_signatures} signatures)`)}`);
        console.log(
          formatTable(
            ["Company", "Signature", "Category", "Sites", "Hits", "Last seen"],
            res.activity.map((a) => [
              a.company || dim("—"),
              a.signature,
              a.category || dim("—"),
              String(a.sites_seen),
              String(a.hit_count),
              a.last_seen,
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });
}
