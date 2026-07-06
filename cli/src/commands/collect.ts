import { Command } from "commander";
import { ethers } from "ethers";
import { readConfig } from "../lib/config.js";
import { loadSigner } from "../lib/wallet.js";
import { connectWalletConnect } from "../lib/wc-connect.js";
import {
  listPermitCollectable,
  listMeteredCollectable,
  collectPermit,
  collectMetered,
  ClaimAwaitingConfirmationsError,
} from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
  microUsd,
} from "../lib/cmd-common.js";
import { bold, green, yellow, dim, formatTable } from "../lib/output.js";
import { USDC_ABI, USDC_BASE } from "../types.js";
import type { CollectableRow, CollectRecordResult } from "../types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RecordFn = (
  apiBase: string,
  token: string,
  id: string,
  txHash: string,
) => Promise<CollectRecordResult>;

/**
 * Record a broadcast tx, retrying only on HTTP 202 ("mined but not deep enough
 * yet"). NEVER re-broadcasts — it re-POSTs the SAME tx_hash, which the backend
 * dedups. Returns the booked result, or null if still awaiting after the retry
 * budget. Non-202 errors propagate to the caller.
 */
async function recordWithPoll(
  recordFn: RecordFn,
  apiBase: string,
  token: string,
  id: string,
  txHash: string,
  jsonOutput: boolean,
): Promise<CollectRecordResult | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await recordFn(apiBase, token, id, txHash);
    } catch (err) {
      if (err instanceof ClaimAwaitingConfirmationsError) {
        if (!jsonOutput) console.log(dim(`Awaiting confirmations… (${attempt + 1}/6)`));
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * The transferFrom is already on-chain but the booking didn't land. This is the
 * ONLY safe message here: re-running `collect` would transfer a second time.
 * Recovery is the idempotent `collect record <id> <tx> --mode <kind>` (no
 * broadcast — the backend dedups on tx_hash).
 */
function reportUnbooked(
  id: string,
  kind: "permit" | "metered",
  txHash: string,
  jsonOutput: boolean,
  reason: string,
): void {
  if (jsonOutput) {
    console.log(JSON.stringify({ transferred: true, booked: false, tx_hash: txHash, reason }));
  } else {
    console.log(
      yellow(`Transfer is on-chain (${txHash}) but not booked yet (${reason}).`) +
        `\n  ${bold("Record it")} ${dim(`(does NOT transfer again): xenarch collect record ${id} ${txHash} --mode ${kind}`)}` +
        dim(`\n  Do NOT re-run \`collect ${kind}\` — that would transfer a second time.`),
    );
  }
  process.exitCode = 1;
}

/**
 * Shared implementation for `collect permit` / `collect metered`.
 *
 * The merchant wallet is the permit `spender`: it broadcasts the on-chain
 * `USDC.transferFrom(owner, spender, amount)` itself (Xenarch never moves the
 * money), then records the tx so the platform books the cycle / settles the
 * metered charges. Real money + gas — heavily preflighted so a doomed transfer
 * is never broadcast, and gated behind a Tier-2 confirm.
 */
async function runCollect(
  kind: "permit" | "metered",
  subscriptionId: string,
  opts: { confirm?: boolean },
  cmd: Command,
): Promise<void> {
  const apiBase = await resolveApiBase(cmd);
  const { jsonOutput } = ctx(cmd, apiBase);
  const token = await loadSession();
  const config = await readConfig();
  const globals = cmd.optsWithGlobals();
  const rpcUrl = globals.rpcUrl ?? config.rpc_url;

  // 1. Find the collectable row for this subscription.
  const bag =
    kind === "permit"
      ? await listPermitCollectable(apiBase, token)
      : await listMeteredCollectable(apiBase, token);
  const row = bag.collectable.find((r) => r.subscription_id === subscriptionId);
  if (!row) {
    throw new Error(
      `Subscription ${subscriptionId} is not in the ${kind} collectable bag right now (nothing due, or the sweep hasn't confirmed it collectable). Check \`xenarch collect list\`.`,
    );
  }
  const tf = row.transfer_from;
  if (!tf?.owner || !tf?.spender || !tf.value) {
    throw new Error("Collectable row is missing transfer_from(owner, spender, value).");
  }
  const owner = ethers.getAddress(tf.owner);
  const spender = ethers.getAddress(tf.spender);
  const amount = BigInt(tf.value); // micro-USDC == USDC base units (6 decimals)

  // 2. Tier-2 confirm FIRST — everything shown comes from the API, so a --json
  //    needs_confirmation check never has to touch (and prompt) the wallet.
  const ok = await confirmMutation(
    jsonOutput,
    `Collect ${microUsd(Number(amount))} USDC from ${owner} to your wallet ${spender}? This broadcasts an on-chain USDC.transferFrom; gas is paid by your wallet.`,
    `collect_${kind}`,
    opts,
  );
  if (!ok) return;

  // 3. Load the signer that must broadcast (the spender = merchant wallet).
  if (!config.wallet) {
    throw new Error("No wallet configured. Run `xenarch wallet generate|import|connect`.");
  }
  let signer: ethers.Signer;
  if (config.wallet.type === "walletconnect") {
    const conn = await connectWalletConnect(config, rpcUrl, { json: jsonOutput });
    signer = conn.signer;
    if (!jsonOutput) console.log(dim("Connected. Approve the transaction on your phone…"));
  } else {
    signer = await loadSigner(rpcUrl);
  }
  const signerAddr = ethers.getAddress(await signer.getAddress());
  if (signerAddr.toLowerCase() !== spender.toLowerCase()) {
    throw new Error(
      `Loaded wallet ${signerAddr} is not the allowance spender ${spender}. transferFrom would revert — import/connect the seller wallet.`,
    );
  }

  // 4. Preflight against chain state (read-only, no gas): the transfer must be
  //    able to succeed before we ever broadcast it.
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdcRead = new ethers.Contract(USDC_BASE, USDC_ABI, provider);
  const [allowance, balance] = await Promise.all([
    usdcRead.allowance(owner, spender) as Promise<bigint>,
    usdcRead.balanceOf(owner) as Promise<bigint>,
  ]);
  if (allowance < amount) {
    throw new Error(
      `On-chain allowance ${microUsd(Number(allowance))} < ${microUsd(Number(amount))} — the buyer's permit hasn't been submitted on-chain yet.`,
    );
  }
  if (balance < amount) {
    throw new Error(
      `Buyer USDC balance ${microUsd(Number(balance))} < ${microUsd(Number(amount))} — insufficient funds to collect.`,
    );
  }
  // Simulate the exact call — throws on any revert we didn't anticipate.
  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, signer);
  await usdc.transferFrom.staticCall(owner, spender, amount);

  // 5. Broadcast. `transferFrom()` throwing here is PRE-broadcast (submission
  //    rejected / WC declined) — nothing moved, safe to surface as an error.
  //    Once it returns a hash the tx IS on-chain, so from that point every
  //    failure (wait, record) must route through the tx-hash + idempotent
  //    `collect record` recovery — NEVER a re-runnable error that would
  //    transfer a second time.
  const tx = await usdc.transferFrom(owner, spender, amount);
  const txHash: string = tx.hash;
  if (!jsonOutput) console.log(dim(`Broadcast ${txHash} — waiting for it to mine…`));

  // 6. Wait + record. Both are post-broadcast → guarded.
  const record = kind === "permit" ? collectPermit : collectMetered;
  let result: CollectRecordResult | null;
  try {
    await tx.wait(1);
    result = await recordWithPoll(record, apiBase, token, subscriptionId, txHash, jsonOutput);
  } catch (err) {
    // If the tx was fee-bumped/reorged (TRANSACTION_REPLACED), the transfer may
    // have landed under a DIFFERENT hash — surface that one so `collect record`
    // targets the tx that actually moved the money.
    const replaced = err as { code?: string; replacement?: { hash?: string } };
    const effectiveHash =
      replaced?.code === "TRANSACTION_REPLACED" && replaced.replacement?.hash
        ? replaced.replacement.hash
        : txHash;
    reportUnbooked(subscriptionId, kind, effectiveHash, jsonOutput, (err as Error).message);
    return;
  }
  if (!result) {
    reportUnbooked(subscriptionId, kind, txHash, jsonOutput, "awaiting confirmations after retries");
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ...result, tx_hash: txHash }));
    return;
  }
  console.log(
    `${green(`Collected ${microUsd(Number(amount))} USDC.`)} ${dim(`tx ${txHash}`)}` +
      (result.cycle != null ? `\n  ${bold("Cycle:")} ${result.cycle}` : "") +
      (result.status ? `\n  ${bold("Status:")} ${result.status}` : ""),
  );
}

export function registerCollectCommands(program: Command): void {
  const collect = program
    .command("collect")
    .description("Collect due subscription cycles on-chain (permit + metered)");

  // --- list ---------------------------------------------------------------
  // Read-only: surfaces the permit + metered subscriptions due for collection,
  // with the (owner, spender, value) the seller's wallet calls transferFrom on.
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
          dim("Collect with `xenarch collect permit <id>` / `collect metered <id>` (broadcasts USDC.transferFrom from your wallet)."),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- permit -------------------------------------------------------------
  collect
    .command("permit <id>")
    .description("Collect one due permit cycle on-chain (broadcasts transferFrom) — Tier-2")
    .option("--confirm", "Confirm non-interactively (moves real money)")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        await runCollect("permit", id, opts, cmd);
      } catch (err) {
        fail(err);
      }
    });

  // --- metered ------------------------------------------------------------
  collect
    .command("metered <id>")
    .description("Settle a metered subscriber's booked charges on-chain — Tier-2")
    .option("--confirm", "Confirm non-interactively (moves real money)")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        await runCollect("metered", id, opts, cmd);
      } catch (err) {
        fail(err);
      }
    });

  // --- record (recovery) --------------------------------------------------
  // Book an ALREADY-broadcast transferFrom by its tx hash. Does NOT transfer —
  // use it when `collect permit/metered` broadcast the tx but the booking call
  // failed (RPC blip, not-yet-confirmed). Idempotent: the backend dedups on
  // tx_hash, so it is always safe to re-run.
  collect
    .command("record <id> <tx-hash>")
    .description("Record an already-broadcast transferFrom tx (recovery; does NOT transfer)")
    .requiredOption("--mode <mode>", "permit | metered")
    .action(async (id: string, txHash: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        if (opts.mode !== "permit" && opts.mode !== "metered") {
          throw new Error("--mode must be 'permit' or 'metered'.");
        }
        const token = await loadSession();
        const record = opts.mode === "permit" ? collectPermit : collectMetered;
        const result = await recordWithPoll(record, apiBase, token, id, txHash, jsonOutput);
        if (!result) {
          if (jsonOutput) {
            console.log(JSON.stringify({ booked: false, tx_hash: txHash, reason: "awaiting confirmations" }));
          } else {
            console.log(
              yellow(`Still awaiting confirmations for ${txHash}.`) +
                dim(" Safe to run `collect record` again in a bit."),
            );
          }
          process.exitCode = 1;
          return;
        }
        if (jsonOutput) {
          console.log(JSON.stringify({ ...result, tx_hash: txHash }));
          return;
        }
        console.log(`${green("Recorded.")} ${dim(`tx ${txHash}`)}${result.status ? ` ${result.status}` : ""}`);
      } catch (err) {
        fail(err);
      }
    });
}
