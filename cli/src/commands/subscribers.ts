import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import {
  listSubscribers,
  getSubscriber,
  listSubscriberCharges,
  getSubscribersRollup,
  exportSubscribersCsv,
  merchantCancelSubscriber,
  suspendSubscriber,
  mintManageLink,
  setPeriodCap,
} from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
  usd,
  microUsd,
} from "../lib/cmd-common.js";
import { bold, green, yellow, red, dim, cyan, formatTable } from "../lib/output.js";
import type { SubscriberListItem } from "../types.js";

/** Derived dunning cell for the list table (XEN-611). */
function dunningCell(s: SubscriberListItem): string {
  const n = s.collection_fail_count ?? 0;
  if (s.status === "failed") return red("suspended");
  if (n > 0) return yellow(`dunning (${n}/5)`);
  if (s.collectable === false) return yellow("past due");
  return dim("—");
}

export function registerSubscribersCommands(program: Command): void {
  const subscribers = program
    .command("subscribers")
    .description("Subscribers across your subscription pay-links");

  // --- list ---------------------------------------------------------------
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
            ["Subscriber", "Link", "Payer", "Mode", "Status", "Cycles", "Amount", "Dunning"],
            res.subscribers.map((s) => [
              s.subscription_id.slice(0, 12),
              s.pay_link_id,
              s.payer_email ?? (s.payer_wallet ? `${s.payer_wallet.slice(0, 10)}…` : dim("—")),
              s.mode,
              s.status === "active" ? green(s.status) : s.status === "cancelled" || s.status === "failed" ? red(s.status) : yellow(s.status),
              String(s.cycles_paid),
              s.amount_usd ? `${usd(s.amount_usd)}${s.cadence ? dim(`/${s.cadence}`) : ""}` : dim("—"),
              dunningCell(s),
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

  // --- get ----------------------------------------------------------------
  subscribers
    .command("get <id>")
    .description("Show one subscriber's full state + payment history")
    .action(async (id: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const d = await getSubscriber(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(d));
          return;
        }
        const price = d.amount_usdc
          ? `${usd(d.amount_usdc)}${d.cadence_label ? dim(`/${d.cadence_label}`) : ""}`
          : dim("usage-based");
        console.log(`${bold("Subscriber")} ${d.subscription_id}
  ${bold("Link:")}      ${d.link_id}${d.plan_name ? ` ${dim(`(${d.plan_name})`)}` : ""}
  ${bold("Mode:")}      ${d.mode}${d.is_metered ? dim(" · metered") : ""}
  ${bold("Status:")}    ${d.status === "active" ? green(d.status) : red(d.status)}
  ${bold("Price:")}     ${price}
  ${bold("Payer:")}     ${d.payer_email ?? d.payer_wallet ?? dim("—")}
  ${bold("Cycles:")}    ${d.cycles_paid}
  ${bold("Next:")}      ${d.next_renewal_at ?? dim("—")}
  ${bold("Created:")}   ${d.created_at}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- charges (metered ledger) -------------------------------------------
  subscribers
    .command("charges <id>")
    .description("Per-subscriber metered charge ledger (booked + settled)")
    .option("--limit <n>", "Page size (1-200)", "100")
    .option("--starting-after <seq>", "Cursor: last charge_seq of the previous page")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        qs.set("limit", opts.limit);
        if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
        const res = await listSubscriberCharges(apiBase, token, id, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        console.log(
          `${bold("Charges")} ${id}  ${dim(
            `charged ${microUsd(res.total_charged_micro)} · collected ${microUsd(res.total_collected_micro)} · outstanding ${microUsd(res.outstanding_micro)}`,
          )}`,
        );
        if (!res.charges.length) {
          console.log(dim("No charges."));
          return;
        }
        console.log(
          formatTable(
            ["Seq", "Status", "Units", "Value", "Booked", "Tx"],
            res.charges.map((c) => [
              String(c.charge_seq),
              c.status === "settled" ? green(c.status) : c.status === "void" ? dim(c.status) : yellow(c.status),
              c.billable_units,
              usd(c.value_usdc),
              c.booked_at,
              c.tx_hash ? `${c.tx_hash.slice(0, 12)}…` : dim("—"),
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

  // --- rollup (KPIs) ------------------------------------------------------
  subscribers
    .command("rollup")
    .description("Subscriber KPIs: active count, MRR, 30d churn")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await getSubscribersRollup(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        const churn = r.churn_30d === null ? dim("—") : `${(r.churn_30d * 100).toFixed(1)}%`;
        console.log(`${bold("Active:")} ${green(String(r.active))}   ${bold("MRR:")} ${usd(r.mrr_usdc)}   ${bold("Churn (30d):")} ${churn}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- export -------------------------------------------------------------
  subscribers
    .command("export")
    .description("Export subscribers as CSV")
    .option("--link-id <id>", "Filter by a subscription link")
    .option("--status <status>", "Filter by status")
    .option("--mode <mode>", "reminder | permit | stream")
    .option("--out <file>", "Write CSV to a file instead of stdout")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        if (opts.linkId) qs.set("link_id", opts.linkId);
        if (opts.status) qs.set("status", opts.status);
        if (opts.mode) qs.set("mode", opts.mode);
        const csv = await exportSubscribersCsv(apiBase, token, qs.toString());
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

  // --- cancel (merchant, reminder-only) -----------------------------------
  subscribers
    .command("cancel <id>")
    .description("Merchant-cancel a subscriber (reminder mode only) — Tier-2")
    .option("--confirm", "Confirm cancellation non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Cancel subscriber ${id}? This stops all future renewals.`,
          "cancel_subscription",
          opts,
        );
        if (!ok) return;
        const r = await merchantCancelSubscriber(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Subscriber cancelled.")} ${r.subscription_id} → ${r.status}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- suspend (merchant, any mode) ---------------------------------------
  subscribers
    .command("suspend <id>")
    .description("Suspend a subscriber — stops dunning, no on-chain change (Tier-2)")
    .option("--confirm", "Confirm suspension non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Suspend subscriber ${id}? They drop out of collection digests; on-chain allowance is unchanged.`,
          "suspend_subscription",
          opts,
        );
        if (!ok) return;
        const r = await suspendSubscriber(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Subscriber suspended.")} ${r.subscription_id} → ${r.status}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- manage-link (mint a hosted-manage URL) -----------------------------
  subscribers
    .command("manage-link <id>")
    .description("Mint a short-lived hosted manage-page URL for a subscriber")
    .option("--ttl <seconds>", "Token lifetime in seconds (60..86400; default 900)")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ttl = opts.ttl ? Number(opts.ttl) : undefined;
        if (ttl !== undefined && !Number.isFinite(ttl)) {
          throw new Error("--ttl must be a number of seconds.");
        }
        const r = await mintManageLink(apiBase, token, id, ttl);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Manage link:")} ${cyan(r.manage_url)}
  ${dim(`Expires ${r.expires_at}`)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- period-cap (metered per-period budget) -----------------------------
  // Manage-token gated on the server. The merchant owns the sub, so we mint a
  // fresh manage token via /manage-link, then set the cap with it — no payer
  // token to paste. Folds XEN-602.
  subscribers
    .command("period-cap <id> <new-cap-usd>")
    .description("Set/raise a metered subscriber's per-period budget (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, newCap: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Set the per-period budget for subscriber ${id} to $${newCap}?`,
          "set_period_cap",
          opts,
        );
        if (!ok) return;
        const mint = await mintManageLink(apiBase, token, id);
        const r = await setPeriodCap(apiBase, token, id, mint.manage_token, newCap);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Period cap set.")} ${r.subscription_id} → ${usd(r.period_cap_usdc)}`);
        if (r.exceeds_permit_runway) {
          console.log(
            yellow("  Warning: the new budget exceeds the remaining permit allowance — the buyer should re-up the permit."),
          );
        }
      } catch (err) {
        fail(err);
      }
    });
}
