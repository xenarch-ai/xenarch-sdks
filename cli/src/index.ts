import { Command } from "commander";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerPayCommand } from "./commands/pay.js";
import { registerHistoryCommand } from "./commands/history.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("xenarch")
    .description("CLI for the Xenarch payment network")
    .version("0.1.0")
    .option("--json", "Output in JSON format")
    .option("--api-base <url>", "Override API base URL")
    .option("--rpc-url <url>", "Override Base RPC URL");

  registerWalletCommands(program);
  registerCheckCommand(program);
  registerPayCommand(program);
  registerHistoryCommand(program);

  return program;
}
