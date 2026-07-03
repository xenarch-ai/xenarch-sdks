import { Command } from "commander";
import { readConfig } from "../lib/config.js";
import {
  createSite,
  getMeSite,
  deleteMeSite,
  putSiteGating,
  putSitePricing,
  rotateSiteToken,
  getSiteTransactions,
  getSiteCategoryBreakdown,
  createSiteClaim,
} from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
  usd,
} from "../lib/cmd-common.js";
import { bold, green, yellow, red, dim, cyan, formatTable } from "../lib/output.js";
import type { SiteDetail, SiteClaimBody } from "../types.js";

function renderGating(d: SiteDetail): void {
  console.log(`${bold("Gating:")}  ${d.gating_enabled ? green("enabled") : dim("disabled")}${d.use_publisher_defaults ? dim("  (using publisher defaults)") : ""}`);
  const cats = Object.entries(d.gated_categories);
  if (cats.length) {
    for (const [cat, gated] of cats) {
      console.log(`  ${gated ? red("gated ") : green("allow ")} ${cat}`);
    }
  }
}

function renderPricing(d: SiteDetail): void {
  console.log(`${bold("Default price:")} ${usd(d.default_price_usd)} ${dim(`/ ${d.default_billing_scope}`)}`);
  if (d.rules.length) {
    console.log(
      formatTable(
        ["Path", "Price", "Scope"],
        d.rules.map((r) => [r.path, usd(r.price_usd), r.billing_scope]),
      ),
    );
  }
}

export function registerSiteCommands(program: Command): void {
  const site = program.command("site").description("Manage sites");

  // --- add (publisher pk_ token — unchanged from the original) ------------
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
        console.error("Not authenticated. Run `xenarch register` first.");
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

  // --- get ----------------------------------------------------------------
  site
    .command("get <id>")
    .description("Show a site's full detail (gating + pricing + rules)")
    .action(async (id: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const d = await getMeSite(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(d));
          return;
        }
        console.log(`${bold("Site")} ${d.id}
  ${bold("Domain:")}      ${d.domain ?? dim("— (awaiting setup)")}
  ${bold("Integration:")} ${d.integration_type ?? dim("—")}
  ${bold("Token hash:")}  ${dim(d.site_token_hash)}
  ${bold("Created:")}     ${d.created_at}`);
        renderPricing(d);
        renderGating(d);
      } catch (err) {
        fail(err);
      }
    });

  // --- rm -----------------------------------------------------------------
  site
    .command("rm <id>")
    .description("Delete a site — removes gating + config (Tier-2)")
    .option("--confirm", "Confirm deletion non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Delete site ${id}? Its gating config and site token are removed permanently.`,
          "delete_site",
          opts,
        );
        if (!ok) return;
        await deleteMeSite(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify({ deleted: true, id }));
          return;
        }
        console.log(`${green("Site deleted.")} ${id}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- gating (show / set) ------------------------------------------------
  site
    .command("gating <id>")
    .description("Show or set a site's gating. No set-flags → show.")
    .option("--enable", "Enable gating")
    .option("--disable", "Disable gating")
    .option("--categories <json>", "Full category→bool map, e.g. '{\"AI Agents\":true}'")
    .option("--use-defaults", "Follow the publisher's gating defaults")
    .option("--own-config", "Use this site's own gating config")
    .option("--confirm", "Confirm the change non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const isSet =
          opts.enable || opts.disable || opts.categories || opts.useDefaults || opts.ownConfig;
        const current = await getMeSite(apiBase, token, id);
        if (!isSet) {
          if (jsonOutput) {
            console.log(JSON.stringify({
              gating_enabled: current.gating_enabled,
              gated_categories: current.gated_categories,
              use_publisher_defaults: current.use_publisher_defaults,
            }));
            return;
          }
          renderGating(current);
          return;
        }
        if (opts.enable && opts.disable) {
          throw new Error("Pass only one of --enable / --disable.");
        }
        if (opts.useDefaults && opts.ownConfig) {
          throw new Error("Pass only one of --use-defaults / --own-config.");
        }
        let categories = current.gated_categories;
        if (opts.categories) {
          try {
            categories = JSON.parse(opts.categories);
          } catch {
            throw new Error("--categories must be a JSON object of category → bool.");
          }
        }
        const body = {
          gating_enabled: opts.enable ? true : opts.disable ? false : current.gating_enabled,
          gated_categories: categories,
          use_publisher_defaults: opts.useDefaults ? true : opts.ownConfig ? false : current.use_publisher_defaults,
        };
        const ok = await confirmMutation(
          jsonOutput,
          `Update gating for site ${id}?`,
          "set_site_gating",
          opts,
        );
        if (!ok) return;
        const r = await putSiteGating(apiBase, token, id, body);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Gating updated.")} ${r.gating_enabled ? green("enabled") : dim("disabled")}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- pricing (show / set) -----------------------------------------------
  site
    .command("pricing <id>")
    .description("Show or set a site's pricing. No set-flags → show.")
    .option("--price <usd>", "Default price per gated request (0–1 USDC)")
    .option("--billing-scope <scope>", "page | path")
    .option("--rules <json>", "Full rules array, e.g. '[{\"path\":\"/x\",\"price_usd\":\"0.01\",\"billing_scope\":\"page\"}]'")
    .option("--confirm", "Confirm the change non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const isSet = opts.price !== undefined || opts.billingScope || opts.rules;
        const current = await getMeSite(apiBase, token, id);
        if (!isSet) {
          if (jsonOutput) {
            console.log(JSON.stringify({
              default_price_usd: current.default_price_usd,
              default_billing_scope: current.default_billing_scope,
              rules: current.rules,
            }));
            return;
          }
          renderPricing(current);
          return;
        }
        if (opts.billingScope && opts.billingScope !== "page" && opts.billingScope !== "path") {
          throw new Error("--billing-scope must be 'page' or 'path'.");
        }
        let rules = current.rules;
        if (opts.rules) {
          try {
            rules = JSON.parse(opts.rules);
          } catch {
            throw new Error("--rules must be a JSON array of {path, price_usd, billing_scope}.");
          }
        }
        const body = {
          default_price_usd: opts.price !== undefined ? String(opts.price) : current.default_price_usd,
          default_billing_scope: (opts.billingScope ?? current.default_billing_scope) as "page" | "path",
          rules,
        };
        const ok = await confirmMutation(
          jsonOutput,
          `Update pricing for site ${id}?`,
          "set_site_pricing",
          opts,
        );
        if (!ok) return;
        const r = await putSitePricing(apiBase, token, id, body);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Pricing updated.")} ${r.rules_applied} rule(s) applied.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- token rotate -------------------------------------------------------
  const token = site.command("token").description("Manage a site's token");
  token
    .command("rotate <id>")
    .description("Rotate a site token — the old token stops working (Tier-2)")
    .option("--confirm", "Confirm rotation non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const session = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Rotate the token for site ${id}? The current token stops authenticating immediately.`,
          "rotate_site_token",
          opts,
        );
        if (!ok) return;
        const r = await rotateSiteToken(apiBase, session, id);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Token rotated.")}

  ${bold("New site token:")} ${r.site_token}

  ${yellow("IMPORTANT:")} Update your integration. The old token no longer works.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- activity (transactions feed) ---------------------------------------
  site
    .command("activity <id>")
    .description("Recent transactions for a site")
    .option("--period <p>", "24h | 7d | 30d | all", "all")
    .option("--status <s>", "paid | blocked | withdraw | all", "all")
    .option("--page <n>", "Page number", "1")
    .option("--per-page <n>", "Page size (1-100)", "25")
    .option("--wallet <addr>", "Narrow to one payout wallet")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        qs.set("period", opts.period);
        qs.set("status", opts.status);
        qs.set("page", opts.page);
        qs.set("per_page", opts.perPage);
        if (opts.wallet) qs.set("wallet", opts.wallet);
        const res = await getSiteTransactions(apiBase, token, id, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.transactions.length) {
          console.log(dim("No transactions."));
          return;
        }
        console.log(
          formatTable(
            ["When", "Type", "Path", "Agent", "Amount", "Status"],
            res.transactions.map((t) => [
              t.created_at,
              t.type,
              t.path,
              t.agent_name ?? dim("—"),
              usd(t.amount_usd),
              t.status === "paid" ? green(t.status) : t.status === "blocked" ? red(t.status) : yellow(t.status),
            ]),
          ),
        );
        console.log(dim(`  page ${res.page}/${Math.max(1, Math.ceil(res.total / res.per_page))} · ${res.total} total`));
      } catch (err) {
        fail(err);
      }
    });

  // --- categories (earnings breakdown) ------------------------------------
  site
    .command("categories <id>")
    .description("Earnings breakdown by bot category")
    .action(async (id: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const res = await getSiteCategoryBreakdown(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.categories.length) {
          console.log(dim("No category earnings yet."));
          return;
        }
        console.log(
          formatTable(
            ["Category", "Earned"],
            res.categories.map((c) => [c.category, usd(c.earned_usd)]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- claim (mint a claim token for the plugin handshake) ----------------
  site
    .command("claim")
    .description("Mint a claim token to connect an integration to a site (Tier-2)")
    .requiredOption("--domain <domain>", "Domain to claim")
    .requiredOption("--integration <type>", "wp | joomla | cf | sdk | cli | custom")
    .option("--confirm", "Confirm non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const valid = ["wp", "joomla", "cf", "sdk", "cli", "custom"];
        if (!valid.includes(opts.integration)) {
          throw new Error(`--integration must be one of: ${valid.join(", ")}.`);
        }
        const ok = await confirmMutation(
          jsonOutput,
          `Mint a claim token for ${opts.domain} (${opts.integration})? This finds or creates the site.`,
          "create_site_claim",
          opts,
        );
        if (!ok) return;
        const body: SiteClaimBody = { domain: opts.domain, integration_type: opts.integration };
        const r = await createSiteClaim(apiBase, token, body);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Claim token minted.")}
  ${bold("Site ID:")}     ${r.site_id}
  ${bold("Claim token:")} ${cyan(r.claim_token)}
  ${bold("Expires in:")}  ${r.expires_in}s`);
      } catch (err) {
        fail(err);
      }
    });
}
