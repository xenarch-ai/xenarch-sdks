import { createRequire } from "node:module";
import { Command } from "commander";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerPayCommand } from "./commands/pay.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerRegisterCommand } from "./commands/register.js";
import { registerSiteCommands } from "./commands/site.js";
import { registerSitesCommand } from "./commands/sites.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerGatingCommands } from "./commands/gating.js";
import { registerBotsCommands } from "./commands/bots.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerLinksCommands } from "./commands/links.js";
import { registerPaymentsCommands } from "./commands/payments.js";
import { registerSubscribersCommands } from "./commands/subscribers.js";
import { registerCollectCommands } from "./commands/collect.js";
import { registerGroupsCommands } from "./commands/groups.js";
import { registerOrdersCommands } from "./commands/orders.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerPayLinkCommand } from "./commands/pay-link.js";

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

  // Merchant ops (SIWE session) — links / payments / subscribers / profile
  registerLinksCommands(program);
  registerPaymentsCommands(program);
  registerSubscribersCommands(program);
  registerCollectCommands(program);
  registerGroupsCommands(program);
  registerOrdersCommands(program);
  registerProfileCommands(program);
  registerPayLinkCommand(program);

  // Publisher commands
  // XEN-522: login + payout commands removed (passwordless auth; payout
  // wallet lives on the identity). register is now passwordless.
  registerRegisterCommand(program);
  registerSiteCommands(program);
  registerSitesCommand(program);
  registerStatsCommand(program);
  registerGatingCommands(program);
  registerBotsCommands(program);

  return program;
}
