import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { loadSigner } from "../lib/wallet.js";
import { fetchGate, verifyPayment } from "../lib/api.js";
import { executePayment } from "../lib/payment.js";
import { loadCache, cacheToken, getValidToken } from "../lib/token-cache.js";
import { bold, green, yellow, cyan, dim } from "../lib/output.js";

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
    .description("Pay for gated content and get an access token")
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
        console.error("Invalid URL. Provide a full URL (e.g. https://example.com/page).");
        process.exitCode = 1;
        return;
      }

      try {
        // Check for cached token first
        const cache = await loadCache();
        const cached = getValidToken(cache, url);
        if (cached) {
          if (jsonOutput) {
            console.log(JSON.stringify({ cached: true, access_token: cached.access_token, expires_at: cached.expires_at }));
            return;
          }
          console.log(`${green("Using cached access token")} (expires ${cached.expires_at})

  ${bold("Token:")} ${cached.access_token}

Use with: curl -H "Authorization: Bearer ${cached.access_token}" ${url}`);
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
          console.log(`${yellow("[DRY RUN]")} Would pay $${gate.price_usd} ${gate.asset} for ${url}

  ${bold("Gate ID:")}    ${gate.gate_id}
  ${bold("Splitter:")}   ${gate.splitter}
  ${bold("Collector:")}  ${gate.collector}
  ${bold("Network:")}    ${gate.network}
  ${bold("Wallet:")}     ${signerAddress}

No transaction sent.`);
          return;
        }

        // Execute payment
        console.log(`Paying $${gate.price_usd} ${gate.asset} for ${url}\n`);

        const paymentResult = await executePayment(gate, signer);

        console.log(`  ${bold("Transaction:")}  ${paymentResult.txHash}`);
        console.log(
          `  ${bold("Status:")}       ${green(`Confirmed (block ${paymentResult.blockNumber})`)}`,
        );

        // Verify payment
        const verification = await verifyPayment(
          gate.verify_url,
          paymentResult.txHash,
        );

        // Cache the token
        await cacheToken({
          url,
          gate_id: gate.gate_id,
          price_usd: gate.price_usd,
          tx_hash: paymentResult.txHash,
          access_token: verification.access_token,
          expires_at: verification.expires_at,
          paid_at: new Date().toISOString(),
        });

        if (jsonOutput) {
          console.log(
            JSON.stringify({
              tx_hash: paymentResult.txHash,
              block_number: paymentResult.blockNumber,
              access_token: verification.access_token,
              expires_at: verification.expires_at,
            }),
          );
          return;
        }

        console.log(`
  ${bold("Access token:")} ${verification.access_token}
  ${bold("Expires:")}      ${verification.expires_at}

${dim("Token cached.")} Use with: curl -H "Authorization: Bearer ${verification.access_token}" ${url}`);
      } catch (err) {
        console.error(`Payment failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
