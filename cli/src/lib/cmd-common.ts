// Shared command helpers for the merchant commands (links / payments /
// subscribers / profile). Mirrors the patterns established in commands/agent.ts
// so the merchant surface behaves identically: same SIWE session, same Tier-2
// confirm gate, same --json convention, same error handling.

import { Command } from "commander";
import * as readline from "node:readline";
import { readConfig } from "./config.js";
import { SessionExpiredError } from "./api.js";
import { bold, red, yellow, dim } from "./output.js";

export interface Ctx {
  jsonOutput: boolean;
  apiBase: string;
}

export function ctx(cmd: Command, apiBase: string): Ctx {
  const globals = cmd.optsWithGlobals();
  return { jsonOutput: globals.json ?? false, apiBase };
}

/** Resolve the API base from --api-base, else config. */
export async function resolveApiBase(cmd: Command): Promise<string> {
  const globals = cmd.optsWithGlobals();
  return globals.apiBase ?? (await readConfig()).api_base;
}

/** Load a live SIWE session token, or fail with a pointer to `agent login`. */
export async function loadSession(): Promise<string> {
  const config = await readConfig();
  if (!config.session_token) {
    throw new Error(
      "Not signed in. Run `xenarch agent login` to authenticate with your wallet.",
    );
  }
  if (
    config.session_expires_at &&
    Date.parse(config.session_expires_at) < Date.now()
  ) {
    throw new Error("Session expired. Run `xenarch agent login` to refresh.");
  }
  return config.session_token;
}

/**
 * Tier-2 confirmation gate for privileged / irreversible actions (revoke,
 * signing a pay-link). Interactive: requires typing "yes". Non-interactive
 * (no TTY): requires an explicit --confirm flag.
 */
export async function confirmTier2(
  promptText: string,
  opts: { confirm?: boolean },
): Promise<boolean> {
  if (opts.confirm) return true;
  if (!process.stdin.isTTY) {
    console.error(
      `${red("Refused.")} ${promptText}\n` +
        `Re-run with ${bold("--confirm")} to proceed non-interactively.`,
    );
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${yellow(promptText)}\nType "yes" to confirm: `, (a) =>
      resolve(a.trim()),
    ),
  );
  rl.close();
  return answer.toLowerCase() === "yes";
}

/**
 * Mutation gate for a privileged/irreversible action. JSON callers get a
 * structured `needs_confirmation` object (unless `--confirm`) and a non-zero
 * exit; interactive/plain callers fall through to the {@link confirmTier2}
 * yes/no prompt. Returns `true` only when the caller may proceed. Mirrors the
 * `links create` needs_confirmation path + the `links revoke` Tier-2 gate.
 */
export async function confirmMutation(
  jsonOutput: boolean,
  promptText: string,
  action: string,
  opts: { confirm?: boolean },
): Promise<boolean> {
  if (opts.confirm) return true;
  if (jsonOutput) {
    console.log(
      JSON.stringify({
        needs_confirmation: true,
        action,
        message: `${promptText} Re-run with --confirm to proceed.`,
      }),
    );
    process.exitCode = 1;
    return false;
  }
  const ok = await confirmTier2(promptText, opts);
  if (!ok) process.exitCode = 1;
  return ok;
}

/** Prompt for one line of input. Returns the default when the user hits enter. */
export async function promptLine(question: string, def?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const suffix = def ? dim(` [${def}]`) : "";
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${question}${suffix}: `, (a) => resolve(a.trim())),
  );
  rl.close();
  return answer || def || "";
}

/** Centralised error handling — friendly message + non-zero exit. */
export function fail(err: unknown): void {
  if (err instanceof SessionExpiredError) {
    console.error(
      `${red("Session expired or invalid.")} Run \`xenarch agent login\`.`,
    );
  } else {
    console.error(`${red("Error:")} ${(err as Error).message}`);
  }
  process.exitCode = 1;
}

export function usd(v: string | null | undefined): string {
  return v === null || v === undefined ? dim("—") : `$${v}`;
}

/** Format an integer micro-USDC (1e-6 USDC) amount as a trimmed dollar string. */
export function microUsd(micro: number): string {
  return `$${(micro / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
