import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { listOrders, shipOrder, exportOrdersCsv } from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
  usd,
} from "../lib/cmd-common.js";
import { green, yellow, dim, formatTable } from "../lib/output.js";

export function registerOrdersCommands(program: Command): void {
  const orders = program
    .command("orders")
    .description("Physical-goods orders from your pay-links");

  // --- list ---------------------------------------------------------------
  orders
    .command("list")
    .description("List paid orders (newest first)")
    .option("--status <status>", "paid | shipped")
    .option("--search <q>", "Match buyer name/email or product")
    .option("--link-id <id>", "Filter to one pay-link")
    .option("--limit <n>", "Page size (1-100)", "25")
    .option("--starting-after <id>", "Cursor: last order_id of the previous page")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        if (opts.status) qs.set("status", opts.status);
        if (opts.search) qs.set("search", opts.search);
        if (opts.linkId) qs.set("link_id", opts.linkId);
        qs.set("limit", opts.limit);
        if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
        const res = await listOrders(apiBase, token, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.orders.length) {
          console.log(dim("No orders."));
          return;
        }
        console.log(
          formatTable(
            ["Order", "Product", "Buyer", "Amount", "Status", "Destination", "Paid"],
            res.orders.map((o) => [
              o.order_id,
              o.product_name ?? dim("—"),
              o.buyer_name ?? o.buyer_email ?? dim("—"),
              usd(o.amount_usd),
              o.status === "shipped" ? green(o.status) : yellow(o.status),
              o.destination ?? dim("—"),
              o.paid_at,
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

  // --- ship ---------------------------------------------------------------
  orders
    .command("ship <id>")
    .description("Mark an order shipped with a tracking number (Tier-2)")
    .requiredOption("--tracking <number>", "Tracking number")
    .option("--carrier <name>", "Carrier (e.g. USPS)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Mark order ${id} shipped (tracking ${opts.tracking})? The buyer is emailed the tracking number.`,
          "ship_order",
          opts,
        );
        if (!ok) return;
        const o = await shipOrder(apiBase, token, id, {
          tracking: opts.tracking,
          ...(opts.carrier ? { carrier: opts.carrier } : {}),
        });
        if (jsonOutput) {
          console.log(JSON.stringify(o));
          return;
        }
        console.log(`${green("Order shipped.")} ${o.order_id} → ${o.status} ${dim(`(${o.tracking})`)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- export -------------------------------------------------------------
  orders
    .command("export")
    .description("Export orders as CSV")
    .option("--status <status>", "paid | shipped")
    .option("--search <q>", "Match buyer name/email or product")
    .option("--link-id <id>", "Filter to one pay-link")
    .option("--out <file>", "Write CSV to a file instead of stdout")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        if (opts.status) qs.set("status", opts.status);
        if (opts.search) qs.set("search", opts.search);
        if (opts.linkId) qs.set("link_id", opts.linkId);
        const csv = await exportOrdersCsv(apiBase, token, qs.toString());
        if (opts.out) {
          await writeFile(opts.out, csv, "utf8");
          if (jsonOutput) {
            console.log(JSON.stringify({ written: opts.out, bytes: Buffer.byteLength(csv) }));
          } else {
            console.log(`${green("Wrote")} ${opts.out} ${dim(`(${Buffer.byteLength(csv)} bytes)`)}`);
          }
          return;
        }
        if (jsonOutput) {
          console.log(JSON.stringify({ csv }));
          return;
        }
        process.stdout.write(csv);
      } catch (err) {
        fail(err);
      }
    });
}
