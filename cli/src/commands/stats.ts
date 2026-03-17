import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { getSiteStats } from "../lib/api.js";
import { bold, green, dim, formatTable } from "../lib/output.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show revenue stats for a site")
    .argument("<site-id>", "Site ID to get stats for")
    .action(async (siteId: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const jsonOutput: boolean = globals.json ?? false;
      const config = await readConfig();
      const apiBase: string = globals.apiBase ?? config.api_base;

      if (!config.auth_token) {
        console.error(
          "Not authenticated. Run `xenarch register` first.",
        );
        process.exitCode = 1;
        return;
      }

      try {
        const stats = await getSiteStats(apiBase, config.auth_token, siteId);

        if (jsonOutput) {
          console.log(JSON.stringify(stats));
          return;
        }

        console.log(`${bold("Site stats")} ${dim(`(${stats.period})`)}

  ${bold("Total gates:")}  ${stats.total_gates}
  ${bold("Total paid:")}   ${stats.total_paid}
  ${bold("Revenue:")}      ${green(`$${stats.revenue_usd}`)}`);

        if (stats.top_pages.length > 0) {
          const pageRows = stats.top_pages.map((p) => [
            p.url,
            String(p.count),
            `$${p.revenue_usd}`,
          ]);
          console.log(`\n${bold("Top pages:")}\n`);
          console.log(
            "  " +
              formatTable(["URL", "Payments", "Revenue"], pageRows).replace(
                /\n/g,
                "\n  ",
              ),
          );
        }

        if (stats.top_agents.length > 0) {
          const agentRows = stats.top_agents.map((a) => [
            a.wallet,
            String(a.count),
            `$${a.total_usd}`,
          ]);
          console.log(`\n${bold("Top agents:")}\n`);
          console.log(
            "  " +
              formatTable(["Wallet", "Payments", "Total"], agentRows).replace(
                /\n/g,
                "\n  ",
              ),
          );
        }
      } catch (err) {
        console.error(`Failed to get stats: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
