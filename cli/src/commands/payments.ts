import { Command } from "commander";
import { listMerchantPayments } from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail, usd } from "../lib/cmd-common.js";
import { green, yellow, dim, formatTable } from "../lib/output.js";

export function registerPaymentsCommands(program: Command): void {
  const payments = program
    .command("payments")
    .description("Payments received across your pay-links");

  payments
    .command("list")
    .description("List received payments (newest first)")
    .option("--limit <n>", "Page size (1-100)", "25")
    .option("--starting-after <id>", "Cursor: last payment id of the previous page")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        qs.set("limit", opts.limit);
        if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
        const res = await listMerchantPayments(apiBase, token, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.payments.length) {
          console.log(dim("No payments received yet."));
          return;
        }
        console.log(
          formatTable(
            ["When", "Amount", "From", "Status", "Link", "Tx"],
            res.payments.map((p) => [
              p.created_at,
              usd(p.amount_usd),
              `${p.from_address.slice(0, 10)}…`,
              p.status === "confirmed" ? green(p.status) : yellow(p.status),
              p.link_id,
              `${p.tx_hash.slice(0, 12)}…`,
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
