import { Command } from "commander";
import { fetchGate, fetchPayJson } from "../lib/api.js";
import { bold, green, cyan, dim } from "../lib/output.js";

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Check if a URL is gated by Xenarch")
    .argument("<url>", "URL to check")
    .action(async (url: string, _opts, cmd) => {
      const { json } = cmd.optsWithGlobals();

      if (!isValidUrl(url)) {
        console.error("Invalid URL. Provide a full URL (e.g. https://example.com/page).");
        process.exitCode = 1;
        return;
      }

      try {
        const [result, payJson] = await Promise.all([
          fetchGate(url),
          fetchPayJson(url),
        ]);

        if (json) {
          console.log(JSON.stringify({ gated: result.gated, gate: result.gate, pay_json: payJson }));
          return;
        }

        if (result.gated && result.gate) {
          const g = result.gate;
          console.log(`${green("Gate detected")} on ${url}

  ${bold("Gate ID:")}    ${g.gate_id}
  ${bold("Price:")}      $${g.price_usd} ${g.asset}
  ${bold("Network:")}    ${g.network}
  ${bold("Splitter:")}   ${g.splitter}
  ${bold("Collector:")}  ${g.collector}
  ${bold("Expires:")}    ${g.expires}

Run ${cyan(`xenarch pay ${url}`)} to pay and access.`);
        } else {
          console.log(`No Xenarch gate detected on ${url}`);
        }

        if (payJson) {
          console.log(`\n${dim("pay.json found at")} ${new URL(url).origin}/.well-known/pay.json`);
          if (payJson.default_price_usd != null) {
            console.log(`  ${bold("Default price:")} $${payJson.default_price_usd}`);
          }
          if (payJson.rules?.length) {
            for (const rule of payJson.rules) {
              console.log(`  ${bold(rule.path)}: $${rule.price_usd}`);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to check URL: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
