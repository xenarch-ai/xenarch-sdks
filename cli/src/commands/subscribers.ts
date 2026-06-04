import { Command } from "commander";
import { listSubscribers } from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail, usd } from "../lib/cmd-common.js";
import { green, yellow, red, dim, formatTable } from "../lib/output.js";

export function registerSubscribersCommands(program: Command): void {
  const subscribers = program
    .command("subscribers")
    .description("Subscribers across your subscription pay-links");

  subscribers
    .command("list")
    .description("List subscribers (newest first)")
    .option("--link-id <id>", "Filter by a subscription link")
    .option("--status <status>", "active | cancelled | pending_email_verification | failed | exhausted")
    .option("--mode <mode>", "reminder | permit | stream")
    .option("--limit <n>", "Page size (1-200)", "50")
    .option("--starting-after <id>", "Cursor: last subscription_id of the previous page")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        if (opts.linkId) qs.set("link_id", opts.linkId);
        if (opts.status) qs.set("status", opts.status);
        if (opts.mode) qs.set("mode", opts.mode);
        qs.set("limit", opts.limit);
        if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
        const res = await listSubscribers(apiBase, token, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.subscribers.length) {
          console.log(dim("No subscribers."));
          return;
        }
        console.log(
          formatTable(
            ["Subscriber", "Link", "Payer", "Mode", "Status", "Cycles", "Amount"],
            res.subscribers.map((s) => [
              s.subscription_id.slice(0, 12),
              s.pay_link_id,
              s.payer_email ?? (s.payer_wallet ? `${s.payer_wallet.slice(0, 10)}…` : dim("—")),
              s.mode,
              s.status === "active" ? green(s.status) : s.status === "cancelled" || s.status === "failed" ? red(s.status) : yellow(s.status),
              String(s.cycles_paid),
              s.amount_usd ? `${usd(s.amount_usd)}${s.cadence ? dim(`/${s.cadence}`) : ""}` : dim("—"),
            ]),
          ),
        );
        if (res.has_more) {
          console.log(dim(`  more… --starting-after ${res.next_cursor}`));
        }
      } catch (err) {
        fail(err);
      }
    });
}
