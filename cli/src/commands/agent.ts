import { Command } from "commander";
import type { Signer } from "ethers";
import * as readline from "node:readline";
import { readConfig, writeConfig } from "../lib/config.js";
import { loadSigner } from "../lib/wallet.js";
import { establishSession } from "../lib/siwe.js";
import { connectWalletConnect } from "../lib/wc-connect.js";
import {
  SessionExpiredError,
  getMeAgent,
  getAgentSummary,
  getAgentCaps,
  putAgentCaps,
  resetAgentDayCap,
  getAgentScope,
  putAgentScope,
  setAgentPause,
  listAgentKeys,
  createAgentKey,
  rotateAgentKey,
  revokeAgentKey,
  listAgentReceipts,
} from "../lib/api.js";
import { bold, green, yellow, red, dim, cyan, formatTable } from "../lib/output.js";
import type { ScopeMode, ScopeRuleInput, AgentCapsPut } from "../types.js";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface Ctx {
  jsonOutput: boolean;
  apiBase: string;
}

function ctx(cmd: Command, apiBase: string): Ctx {
  const globals = cmd.optsWithGlobals();
  return { jsonOutput: globals.json ?? false, apiBase };
}

/** Resolve the API base from --api-base, else config. */
async function resolveApiBase(cmd: Command): Promise<string> {
  const globals = cmd.optsWithGlobals();
  return globals.apiBase ?? (await readConfig()).api_base;
}

/** Load a live SIWE session token, or fail with a pointer to `agent login`. */
async function loadSession(): Promise<string> {
  const config = await readConfig();
  if (!config.session_token) {
    throw new Error(
      "Not signed in to the agent control plane. Run `xenarch agent login`.",
    );
  }
  if (
    config.session_expires_at &&
    Date.parse(config.session_expires_at) < Date.now()
  ) {
    throw new Error(
      "Agent session expired. Run `xenarch agent login` to refresh.",
    );
  }
  return config.session_token;
}

/**
 * Tier-2 confirmation gate for privileged actions (raising caps, loosening
 * scope, key lifecycle). Interactive: requires typing "yes". Non-interactive
 * (no TTY): requires an explicit --confirm flag — there is deliberately no
 * generic --yes bypass for these.
 */
async function confirmTier2(
  prompt: string,
  opts: { confirm?: boolean },
): Promise<boolean> {
  if (opts.confirm) return true;
  if (!process.stdin.isTTY) {
    console.error(
      `${red("Refused.")} ${prompt}\n` +
        `This is a privileged action. Re-run with ${bold("--confirm")} to proceed non-interactively.`,
    );
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${yellow(prompt)}\nType "yes" to confirm: `, (a) =>
      resolve(a.trim()),
    ),
  );
  rl.close();
  return answer.toLowerCase() === "yes";
}

/** Centralised error handling — friendly message + non-zero exit. */
function fail(err: unknown): void {
  if (err instanceof SessionExpiredError) {
    console.error(
      `${red("Session expired or invalid.")} Run \`xenarch agent login\`.`,
    );
  } else {
    console.error(`${red("Error:")} ${(err as Error).message}`);
  }
  process.exitCode = 1;
}

function usd(v: string | null): string {
  return v === null ? dim("—") : `$${v}`;
}

// ---------------------------------------------------------------------------
// command registration
// ---------------------------------------------------------------------------

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage your agent control plane (caps, scope, keys, spend)");

  // --- login --------------------------------------------------------------
  agent
    .command("login")
    .description("Sign in to the agent control plane with your wallet (SIWE)")
    .option(
      "--qr",
      "Pair a phone wallet via WalletConnect QR and sign in (one step)",
    )
    .action(async (opts, cmd: Command) => {
      try {
        const config = await readConfig();
        const globals = cmd.optsWithGlobals();
        const apiBase = globals.apiBase ?? config.api_base;
        const rpcUrl = globals.rpcUrl ?? config.rpc_url;
        const jsonOutput: boolean = globals.json ?? false;

        // WalletConnect must pair + sign in ONE process (XEN-407): restoring a
        // WC session from disk in a separate invocation can't decrypt the
        // signature response. So for --qr (or a stored WC wallet) we connect
        // fresh here and sign with that live client. Local wallets sign
        // directly with no relay.
        const useWc = opts.qr || config.wallet?.type === "walletconnect";

        let signer: Signer;
        let wcWallet: typeof config.wallet = null;
        if (useWc) {
          const conn = await connectWalletConnect(config, rpcUrl, {
            json: jsonOutput,
          });
          signer = conn.signer;
          wcWallet = {
            type: "walletconnect",
            address: conn.address,
            session_topic: conn.sessionTopic,
            relay_url: "irn",
          };
          if (!jsonOutput) {
            console.log(
              dim("Connected. Approve the signature request on your phone…"),
            );
          }
        } else {
          signer = await loadSigner(rpcUrl);
          if (!jsonOutput) {
            console.log(
              dim("Requesting a sign-in signature from your wallet — approve it to continue…"),
            );
          }
        }

        const session = await establishSession(apiBase, signer);

        config.session_token = session.token;
        config.session_expires_at = session.expiresAt;
        if (wcWallet) config.wallet = wcWallet;
        await writeConfig(config);

        if (jsonOutput) {
          console.log(
            JSON.stringify({
              signed_in: true,
              address: session.address,
              expires_at: session.expiresAt,
            }),
          );
          return;
        }
        console.log(`${green("Signed in to the agent control plane.")}

  ${bold("Wallet:")}  ${session.address}
  ${bold("Expires:")} ${session.expiresAt}

  Session saved to ~/.xenarch/config.json. Try ${cyan("xenarch agent status")}.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- status -------------------------------------------------------------
  agent
    .command("status")
    .description("Show agent profile, pause state, and recent spend")
    .option("--period <period>", "Summary window: 24h | 7d | 30d | all", "24h")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const [profile, summary] = await Promise.all([
          getMeAgent(apiBase, token),
          getAgentSummary(apiBase, token, opts.period),
        ]);

        if (jsonOutput) {
          console.log(JSON.stringify({ profile, summary }));
          return;
        }
        console.log(`${bold("Agent")} ${profile.display_name ?? dim("(unnamed)")}${profile.label ? dim(` [${profile.label}]`) : ""}
  ${bold("State:")}  ${profile.paused ? red("PAUSED") : green("active")}
  ${bold("Spend (")}${summary.period}${bold("):")} $${summary.total_usd} over ${summary.count} payment(s)`);
        const sources = Object.entries(summary.by_source);
        if (sources.length) {
          console.log(
            "  " +
              dim("by source: ") +
              sources.map(([s, v]) => `${s} $${v}`).join(", "),
          );
        }
      } catch (err) {
        fail(err);
      }
    });

  // --- caps ---------------------------------------------------------------
  const caps = agent
    .command("caps")
    .description("View spending caps (per-transaction, daily, monthly)")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const c = await getAgentCaps(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(c));
          return;
        }
        console.log(formatTable(
          ["Axis", "Cap", "Remaining", "Resets"],
          [
            ["per-tx", usd(c.per_tx_usd), dim("n/a"), dim("—")],
            ["daily", usd(c.daily_usd), usd(c.remaining_today), c.resets_today_at],
            ["monthly", usd(c.monthly_usd), usd(c.remaining_month), c.resets_month_at],
          ],
        ));
      } catch (err) {
        fail(err);
      }
    });

  caps
    .command("set")
    .description("Set spending caps. Omit an axis to leave it unchanged; pass 'none' to disable it.")
    .option("--per-tx <usd>", "Per-transaction cap in USD, or 'none'")
    .option("--daily <usd>", "Daily cap in USD, or 'none'")
    .option("--monthly <usd>", "Monthly cap in USD, or 'none'")
    .option("--confirm", "Confirm a cap raise non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const current = await getAgentCaps(apiBase, token);
        const next: AgentCapsPut = {
          per_tx_usd: current.per_tx_usd,
          daily_usd: current.daily_usd,
          monthly_usd: current.monthly_usd,
        };

        const apply = (
          axis: keyof AgentCapsPut,
          raw: string | undefined,
        ): void => {
          if (raw === undefined) return; // unchanged
          if (raw.toLowerCase() === "none" || raw.toLowerCase() === "off") {
            next[axis] = null;
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`Invalid amount for ${axis}: ${raw}`);
          }
          next[axis] = raw;
        };
        apply("per_tx_usd", opts.perTx);
        apply("daily_usd", opts.daily);
        apply("monthly_usd", opts.monthly);

        // Tier-2: a "loosening" is removing a cap, or raising a numeric one.
        const loosened = (["per_tx_usd", "daily_usd", "monthly_usd"] as const).some(
          (axis) => {
            const before = current[axis];
            const after = next[axis];
            if (before !== null && after === null) return true; // cap removed
            if (before !== null && after !== null && Number(after) > Number(before))
              return true; // cap raised
            return false;
          },
        );
        if (loosened) {
          const ok = await confirmTier2(
            "You are raising or removing a spending cap — this widens what the agent may spend.",
            opts,
          );
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }

        const updated = await putAgentCaps(apiBase, token, next);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Caps updated.")}  per-tx ${usd(updated.per_tx_usd)} · daily ${usd(updated.daily_usd)} · monthly ${usd(updated.monthly_usd)}`);
      } catch (err) {
        fail(err);
      }
    });

  caps
    .command("reset-day")
    .description("Reset today's spent counter back to the full daily cap")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await resetAgentDayCap(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(
          `${green("Daily counter reset.")} Remaining today: ${usd(r.new_remaining)} (resets ${r.resets_at}).`,
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- scope --------------------------------------------------------------
  const scope = agent
    .command("scope")
    .description("View allow/deny rules and default posture")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const s = await getAgentScope(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(s));
          return;
        }
        console.log(`${bold("Default:")} ${s.default_mode === "allow" ? yellow("allow") : green("deny")}`);
        if (!s.rules.length) {
          console.log(dim("  no rules"));
          return;
        }
        console.log(
          formatTable(
            ["ID", "Mode", "Pattern", "Hits", "Label"],
            s.rules.map((r) => [
              r.id.slice(0, 8),
              r.mode === "deny" ? green(r.mode) : yellow(r.mode),
              r.pattern,
              String(r.hit_count),
              r.label ?? dim("—"),
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  scope
    .command("add <pattern>")
    .description("Add an allow/deny rule (default --deny)")
    .option("--allow", "Allow rule (loosens scope — Tier-2)")
    .option("--deny", "Deny rule (tightens scope)")
    .option("--label <label>", "Optional human label")
    .option("--confirm", "Confirm an allow rule non-interactively")
    .action(async (pattern: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        if (opts.allow && opts.deny) {
          throw new Error("Pass only one of --allow / --deny.");
        }
        const mode: ScopeMode = opts.allow ? "allow" : "deny";

        if (mode === "allow") {
          const ok = await confirmTier2(
            `Adding an allow rule for "${pattern}" widens what the agent may pay for.`,
            opts,
          );
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }

        const s = await getAgentScope(apiBase, token);
        const rules: ScopeRuleInput[] = s.rules.map((r) => ({
          pattern: r.pattern,
          mode: r.mode,
          label: r.label,
        }));
        rules.push({ pattern, mode, label: opts.label ?? null });

        const updated = await putAgentScope(apiBase, token, s.default_mode, rules);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Rule added.")} ${mode} ${pattern} (${updated.rules.length} rule(s) total).`);
      } catch (err) {
        fail(err);
      }
    });

  scope
    .command("rm <id>")
    .description("Remove a scope rule by id (full or 8-char prefix)")
    .option("--confirm", "Confirm removing a deny rule non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const s = await getAgentScope(apiBase, token);
        const target = s.rules.find((r) => r.id === id || r.id.startsWith(id));
        if (!target) {
          throw new Error(`No scope rule matches id "${id}".`);
        }

        // Removing a deny rule loosens scope → Tier-2.
        if (target.mode === "deny") {
          const ok = await confirmTier2(
            `Removing deny rule "${target.pattern}" lets the agent pay for it again.`,
            opts,
          );
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }

        const rules: ScopeRuleInput[] = s.rules
          .filter((r) => r.id !== target.id)
          .map((r) => ({ pattern: r.pattern, mode: r.mode, label: r.label }));

        const updated = await putAgentScope(apiBase, token, s.default_mode, rules);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Rule removed.")} ${updated.rules.length} rule(s) remain.`);
      } catch (err) {
        fail(err);
      }
    });

  scope
    .command("default <mode>")
    .description("Set default posture: allow | deny")
    .option("--confirm", "Confirm switching to default-allow non-interactively")
    .action(async (mode: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        if (mode !== "allow" && mode !== "deny") {
          throw new Error("Mode must be 'allow' or 'deny'.");
        }

        // default-allow is the most permissive posture → Tier-2.
        if (mode === "allow") {
          const ok = await confirmTier2(
            "Switching to default-allow lets the agent pay for anything not explicitly denied.",
            opts,
          );
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }

        const s = await getAgentScope(apiBase, token);
        const rules: ScopeRuleInput[] = s.rules.map((r) => ({
          pattern: r.pattern,
          mode: r.mode,
          label: r.label,
        }));
        const updated = await putAgentScope(apiBase, token, mode as ScopeMode, rules);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Default posture:")} ${updated.default_mode}.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- pause / resume -----------------------------------------------------
  agent
    .command("pause")
    .description("Kill switch: block all of the agent's payments immediately")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await setAgentPause(apiBase, token, true);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${red("Agent paused.")} All payments blocked as of ${r.updated_at}.`);
      } catch (err) {
        fail(err);
      }
    });

  agent
    .command("resume")
    .description("Lift the pause and let the agent pay again (Tier-2)")
    .option("--confirm", "Confirm resume non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const ok = await confirmTier2(
          "Resuming lets the agent spend again, subject to its caps and scope.",
          opts,
        );
        if (!ok) {
          process.exitCode = 1;
          return;
        }

        const r = await setAgentPause(apiBase, token, false);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Agent resumed.")} Payments re-enabled as of ${r.updated_at}.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- keys ---------------------------------------------------------------
  const keys = agent
    .command("keys")
    .description("List the agent's xa_live_* API keys")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const list = await listAgentKeys(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(list));
          return;
        }
        if (!list.length) {
          console.log(dim("No API keys. Create one with `xenarch agent keys create`."));
          return;
        }
        console.log(
          formatTable(
            ["ID", "Key", "Label", "Last used", "Status"],
            list.map((k) => [
              k.id.slice(0, 8),
              `xa_live_····${k.hash_preview}`,
              k.label ?? dim("—"),
              k.last_used_at ?? dim("never"),
              k.revoked_at ? red("revoked") : green("active"),
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  keys
    .command("create")
    .description("Issue a new xa_live_* key (plaintext shown once) — Tier-2")
    .option("--label <label>", "Optional key label")
    .option("--confirm", "Confirm key creation non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const ok = await confirmTier2(
          "Creating an API key issues a new credential that can spend on the agent's behalf.",
          opts,
        );
        if (!ok) {
          process.exitCode = 1;
          return;
        }

        const issued = await createAgentKey(apiBase, token, opts.label ?? null);
        if (jsonOutput) {
          console.log(JSON.stringify(issued));
          return;
        }
        console.log(`${green("Key created.")} ${yellow("Copy it now — it is shown only once:")}

  ${bold(issued.plaintext)}
`);
      } catch (err) {
        fail(err);
      }
    });

  keys
    .command("rotate <id>")
    .description("Rotate a key — invalidates the old secret (Tier-2)")
    .option("--confirm", "Confirm rotation non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const ok = await confirmTier2(
          `Rotating key ${id} immediately invalidates its current secret.`,
          opts,
        );
        if (!ok) {
          process.exitCode = 1;
          return;
        }

        const issued = await rotateAgentKey(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(issued));
          return;
        }
        console.log(`${green("Key rotated.")} ${yellow("New secret (shown once):")}

  ${bold(issued.plaintext)}
`);
      } catch (err) {
        fail(err);
      }
    });

  keys
    .command("revoke <id>")
    .description("Revoke a key permanently (Tier-2)")
    .option("--confirm", "Confirm revocation non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const ok = await confirmTier2(
          `Revoking key ${id} permanently disables it — anything using it stops working.`,
          opts,
        );
        if (!ok) {
          process.exitCode = 1;
          return;
        }

        await revokeAgentKey(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify({ revoked: true, id }));
          return;
        }
        console.log(`${green("Key revoked.")} ${id}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- receipts -----------------------------------------------------------
  agent
    .command("receipts")
    .description("List the agent's payment receipts")
    .option("--period <period>", "24h | 7d | 30d | all", "all")
    .option("--status <status>", "paid | pending | failed")
    .option("--source <source>", "cli | mcp | sdk | custom")
    .option("--domain <domain>", "Filter by domain")
    .option("--page <n>", "Page number", "1")
    .option("--per-page <n>", "Rows per page (max 100)", "25")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const params = new URLSearchParams();
        params.set("period", opts.period);
        if (opts.status) params.set("status", opts.status);
        if (opts.source) params.set("source", opts.source);
        if (opts.domain) params.set("domain", opts.domain);
        params.set("page", opts.page);
        params.set("per_page", opts.perPage);

        const list = await listAgentReceipts(apiBase, token, params.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(list));
          return;
        }
        if (!list.receipts.length) {
          console.log(dim("No receipts for that filter."));
          return;
        }
        console.log(
          formatTable(
            ["When", "Amount", "Domain", "Status", "Source"],
            list.receipts.map((r) => [
              r.paid_at,
              `$${r.amount_usd}`,
              r.domain,
              r.status === "paid" ? green(r.status) : r.status === "failed" ? red(r.status) : yellow(r.status),
              r.source,
            ]),
          ),
        );
        console.log(
          dim(`  page ${list.page} · ${list.receipts.length} of ${list.total} total`),
        );
      } catch (err) {
        fail(err);
      }
    });
}
