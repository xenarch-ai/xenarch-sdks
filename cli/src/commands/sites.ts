import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { listSites } from "../lib/api.js";
import { bold, formatTable } from "../lib/output.js";

export function registerSitesCommand(program: Command): void {
  program
    .command("sites")
    .description("List your registered sites")
    .action(async (_opts, cmd) => {
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
        const sites = await listSites(apiBase, config.auth_token);

        if (jsonOutput) {
          console.log(JSON.stringify(sites));
          return;
        }

        if (sites.length === 0) {
          console.log("No sites registered. Run `xenarch site add <domain>` to add one.");
          return;
        }

        const rows = sites.map((s) => [
          s.id,
          s.domain,
          `$${s.default_price_usd}`,
          new Date(s.created_at).toISOString().slice(0, 16).replace("T", " "),
        ]);

        console.log(`${bold("Your sites:")}\n`);
        console.log(
          "  " +
            formatTable(["ID", "Domain", "Price", "Created"], rows).replace(
              /\n/g,
              "\n  ",
            ),
        );
      } catch (err) {
        console.error(`Failed to list sites: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
