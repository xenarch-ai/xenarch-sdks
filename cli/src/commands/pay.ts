import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { loadSigner } from "../lib/wallet.js";
import { fetchGate, fetchWithReplay } from "../lib/api.js";
import { executePayment } from "../lib/payment.js";
import { loadCache, cacheToken, getRecentPayment } from "../lib/token-cache.js";
import { bold, green, yellow, dim } from "../lib/output.js";

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerPayCommand(program: Command): void {
  program
    .command("pay")
    .description("Pay for gated content via a third-party x402 facilitator")
    .argument("<url>", "URL to pay for")
    .option("--dry-run", "Show what would happen without sending a transaction")
    .option(
      "--max-price <usd>",
      "Refuse to pay if price exceeds this amount in USD",
      "1.00",
    )
    .action(async (url: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const jsonOutput: boolean = globals.json ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const maxPrice = parseFloat(opts.maxPrice);

      if (!isValidUrl(url)) {
        console.error(
          "Invalid URL. Provide a full URL (e.g. https://example.com/page).",
        );
        process.exitCode = 1;
        return;
      }

      try {
        // Short-circuit if we have a recent on-chain payment for this URL —
        // the publisher's middleware will accept the same gate_id + tx_hash
        // until its verification window closes.
        const cache = await loadCache();
        const cached = getRecentPayment(cache, url);
        if (cached) {
          if (jsonOutput) {
            console.log(
              JSON.stringify({
                cached: true,
                gate_id: cached.gate_id,
                tx_hash: cached.tx_hash,
                facilitator: cached.facilitator,
              }),
            );
            return;
          }
          console.log(`${green("Reusing recent payment")} for ${url}

  ${bold("Gate ID:")}     ${cached.gate_id}
  ${bold("Tx hash:")}     ${cached.tx_hash}
  ${bold("Facilitator:")} ${cached.facilitator}

Replay with:
  curl -H "X-Xenarch-Gate-Id: ${cached.gate_id}" \\
       -H "X-Xenarch-Tx-Hash: ${cached.tx_hash}" \\
       ${url}`);
          return;
        }

        // Load config and signer
        const config = await readConfig();
        const rpcUrl = globals.rpcUrl ?? config.rpc_url;

        const signer = await loadSigner(rpcUrl);
        const signerAddress = await signer.getAddress();

        // Fetch gate
        const result = await fetchGate(url);
        if (!result.gated || !result.gate) {
          console.log("This URL is not gated by Xenarch.");
          return;
        }

        const gate = result.gate;
        const price = parseFloat(gate.price_usd);

        // Check max price
        if (price > maxPrice) {
          console.error(
            `Price $${gate.price_usd} exceeds max price $${maxPrice.toFixed(2)}. Use --max-price to increase the limit.`,
          );
          process.exitCode = 1;
          return;
        }

        // Check gate expiry
        if (new Date(gate.expires) <= new Date()) {
          console.error("Gate has expired. Re-fetch the URL for a new gate.");
          process.exitCode = 1;
          return;
        }

        if (dryRun) {
          if (jsonOutput) {
            console.log(JSON.stringify({ dry_run: true, gate }));
            return;
          }
          const facilitatorList = gate.facilitators
            .map((f) => `${f.name} (${f.url})`)
            .join("\n               ");
          console.log(`${yellow("[DRY RUN]")} Would pay $${gate.price_usd} ${gate.asset} for ${url}

  ${bold("Gate ID:")}     ${gate.gate_id}
  ${bold("Seller:")}      ${gate.seller_wallet}
  ${bold("Network:")}     ${gate.network}
  ${bold("Wallet:")}      ${signerAddress}
  ${bold("Facilitators:")} ${facilitatorList || "(none advertised)"}

No transaction sent.`);
          return;
        }

        // Execute payment via third-party facilitator
        console.log(`Paying $${gate.price_usd} ${gate.asset} for ${url}\n`);

        const paymentResult = await executePayment(gate, signer);

        console.log(`  ${bold("Tx hash:")}     ${paymentResult.tx_hash}`);
        console.log(
          `  ${bold("Facilitator:")} ${green(paymentResult.facilitator)}`,
        );

        // Replay the gated URL with the canonical Xenarch headers — this
        // is what gets the user the actual content. The publisher's
        // middleware re-verifies the on-chain tx behind the scenes.
        const replay = await fetchWithReplay(
          url,
          paymentResult.gate_id,
          paymentResult.tx_hash,
        );
        const replayOk = replay.ok;

        // Cache for future short-circuits and `xenarch history`.
        await cacheToken({
          url,
          gate_id: gate.gate_id,
          price_usd: gate.price_usd,
          tx_hash: paymentResult.tx_hash,
          facilitator: paymentResult.facilitator,
          paid_at: new Date().toISOString(),
        });

        if (jsonOutput) {
          console.log(
            JSON.stringify({
              tx_hash: paymentResult.tx_hash,
              facilitator: paymentResult.facilitator,
              gate_id: paymentResult.gate_id,
              amount_usd: paymentResult.amount_usd,
              replay_status: replay.status,
              replay_ok: replayOk,
            }),
          );
          return;
        }

        if (replayOk) {
          console.log(
            `  ${bold("Replay:")}      ${green(`HTTP ${replay.status}`)}`,
          );
        } else {
          console.log(
            `  ${bold("Replay:")}      ${yellow(`HTTP ${replay.status} (publisher did not serve content)`)}`,
          );
        }

        console.log(`
${dim("Payment cached.")} Replay anytime with:
  curl -H "X-Xenarch-Gate-Id: ${paymentResult.gate_id}" \\
       -H "X-Xenarch-Tx-Hash: ${paymentResult.tx_hash}" \\
       ${url}`);
      } catch (err) {
        console.error(`Payment failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
