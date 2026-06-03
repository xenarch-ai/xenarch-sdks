import { createRequire } from "node:module";
import { Command } from "commander";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerPayCommand } from "./commands/pay.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerRegisterCommand } from "./commands/register.js";
import { registerSiteAddCommand } from "./commands/site-add.js";
import { registerSitesCommand } from "./commands/sites.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerPayoutCommand } from "./commands/payout.js";
import { registerAgentCommands } from "./commands/agent.js";

/**
 * Resolve the package version from package.json so `--version` never drifts
 * from the published version. The relative depth differs between dev
 * (`src/index.ts`) and the tsc build (`dist/src/index.js`), so try both.
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      return (require(rel) as { version: string }).version;
    } catch {
      // try the next candidate path
    }
  }
  return "0.0.0";
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("xenarch")
    .description("CLI for the Xenarch payment network")
    .version(packageVersion())
    .option("--json", "Output in JSON format")
    .option("--api-base <url>", "Override API base URL")
    .option("--rpc-url <url>", "Override Base RPC URL");

  // Agent commands
  registerWalletCommands(program);
  registerCheckCommand(program);
  registerPayCommand(program);
  registerHistoryCommand(program);

  // Agent control plane (SIWE session)
  registerAgentCommands(program);

  // Publisher commands
  registerLoginCommand(program);
  registerRegisterCommand(program);
  registerSiteAddCommand(program);
  registerSitesCommand(program);
  registerStatsCommand(program);
  registerPayoutCommand(program);

  return program;
}
