import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { payLinkWrapped, loadPayerSigner } from "../lib/pay-link-flow.js";
import { reportReceipt } from "../lib/agent-receipts.js";
import { bold, green, yellow, dim, cyan } from "../lib/output.js";

export function registerPayLinkCommand(program: Command): void {
  program
    .command("pay-link")
    .description("Pay a Xenarch pay-link by id (wrapped x402 settle + claim)")
    .argument("<id>", "Pay-link id")
    .option(
      "--max-price <usd>",
      "Refuse to pay if price exceeds this amount in USD",
      "1.00",
    )
    .action(async (id: string, opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const jsonOutput: boolean = globals.json ?? false;
      try {
        const config = await readConfig();
        const apiBase = globals.apiBase ?? config.api_base;
        const rpcUrl = globals.rpcUrl ?? config.rpc_url;

        const signer = await loadPayerSigner(config, rpcUrl, jsonOutput);
        const signerAddress = await signer.getAddress();
        if (!jsonOutput && config.wallet?.type === "walletconnect") {
          console.log(dim("Connected. Approve the payment on your phone…"));
        }
        if (!jsonOutput) console.log(`Paying pay-link ${bold(id)}…\n`);

        const res = await payLinkWrapped(apiBase, id, signer, {
          maxPriceUsd: parseFloat(opts.maxPrice),
        });

        // Report to the agent control plane (best-effort; no-op without a token).
        await reportReceipt(config.api_base, {
          url: `${apiBase}/v1/links/${id}`,
          amount_usd: res.amount_usd,
          source: "cli",
          status: res.claim.status === "confirmed" ? "paid" : "pending",
          paid_at: new Date().toISOString(),
          tx_hash: res.tx_hash,
          facilitator: res.facilitator,
          wallet_address: signerAddress,
          auth_token: res.auth_token,
        });

        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        const statusColor = res.claim.status === "confirmed" ? green : yellow;
        console.log(`${green("Paid.")}

  ${bold("Tx hash:")}     ${res.tx_hash}
  ${bold("Facilitator:")} ${res.facilitator}
  ${bold("Amount:")}      $${res.amount_usd}${res.claim.value_usdc !== res.amount_usd ? dim(` (settled $${res.claim.value_usdc})`) : ""}
  ${bold("Status:")}      ${statusColor(res.claim.status)}
  ${bold("Block:")}       ${res.claim.block_number}${res.claim.manage_url ? `\n  ${bold("Manage:")}      ${cyan(res.claim.manage_url)}` : ""}`);
      } catch (err) {
        if (jsonOutput) {
          console.log(JSON.stringify({ error: (err as Error).message }));
        } else {
          console.error(`Payment failed: ${(err as Error).message}`);
        }
        process.exitCode = 1;
      }
    });
}
