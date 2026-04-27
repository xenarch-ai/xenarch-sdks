import { Command } from "commander";
import { loadCache } from "../lib/token-cache.js";
import { bold, formatTable } from "../lib/output.js";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show recent payment history from local cache")
    .action(async (_opts, cmd) => {
      const { json } = cmd.optsWithGlobals();

      try {
        const entries = await loadCache();

        if (entries.length === 0) {
          if (json) {
            console.log(JSON.stringify([]));
            return;
          }
          console.log("No payment history found.");
          return;
        }

        if (json) {
          console.log(JSON.stringify(entries));
          return;
        }

        // Post-XEN-179: no access tokens, no expiry. The history is just
        // an audit trail of on-chain settlements.
        const rows = entries
          .slice()
          .reverse()
          .map((e) => {
            const date = new Date(e.paid_at)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ");
            const txShort = `${e.tx_hash.slice(0, 10)}…${e.tx_hash.slice(-6)}`;
            return [e.url, `$${e.price_usd}`, txShort, date];
          });

        console.log(`${bold("Recent payments:")}\n`);
        console.log(
          "  " +
            formatTable(["URL", "Price", "Tx", "Date"], rows).replace(
              /\n/g,
              "\n  ",
            ),
        );
      } catch (err) {
        console.error(`Failed to read history: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
