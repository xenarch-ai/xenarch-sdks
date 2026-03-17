import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import { createSite } from "../lib/api.js";
import { bold, green, yellow } from "../lib/output.js";

export function registerSiteAddCommand(program: Command): void {
  const site = program
    .command("site")
    .description("Manage sites");

  site
    .command("add")
    .description("Register a site with Xenarch")
    .argument("<domain>", "Domain to register (e.g. myblog.com)")
    .action(async (domain: string, _opts, cmd) => {
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
        const result = await createSite(apiBase, config.auth_token, domain);

        if (jsonOutput) {
          console.log(JSON.stringify({ id: result.id, site_token: result.site_token }));
          return;
        }

        console.log(`${green("Site registered.")}

  ${bold("Site ID:")}    ${result.id}
  ${bold("Domain:")}     ${domain}
  ${bold("Site Token:")} ${result.site_token}

  ${yellow("IMPORTANT:")} Save your site token. It will not be shown again.`);
      } catch (err) {
        console.error(`Failed to add site: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
