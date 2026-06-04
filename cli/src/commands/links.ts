import { Command } from "commander";
import { ethers } from "ethers";
import { readConfig } from "../lib/config.js";
import { loadSigner } from "../lib/wallet.js";
import { connectWalletConnect } from "../lib/wc-connect.js";
import {
  getLinkSchema,
  validateLink,
  createLink,
  listLinks,
  getLinkDetail,
  revokeLink,
} from "../lib/api.js";
import { signPayLink, stringifyNumbers, type PayLinkLit } from "../lib/pay-link-signer.js";
import { newIdempotencyKey, recordIdempotency } from "../lib/idempotency.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmTier2,
  promptLine,
  fail,
  usd,
} from "../lib/cmd-common.js";
import { bold, green, yellow, red, dim, cyan, formatTable } from "../lib/output.js";
import type {
  PayLinkSchemaResponse,
  PayLinkValidateResponse,
  LitValue,
} from "../types.js";

// Minimal offline fallback for the create-body descriptor (sdk-mcp-cli-parity
// §12.5). Used only when GET /v1/links/schema is unreachable; the live schema
// is authoritative.
const BUNDLED_SCHEMA: PayLinkSchemaResponse = {
  version: "bundled-fallback",
  currency: { default: "USDC", supported: ["USDC"] },
  network: { default: "base", supported: ["base"] },
  max_amount_usd: "1.00",
  fields: [
    { field: "to", group: "A", type: "address", required: true, state: "lit", prompt: "Recipient wallet", advanced: false, enum: null, default: null, auto_fill: "wallet", help: null },
    { field: "amount", group: "A", type: "amount", required: true, state: "lit", prompt: "Amount in USDC (max 1.00) or 'open'", advanced: false, enum: null, default: null, auto_fill: null, help: null },
    { field: "currency", group: "A", type: "enum", required: true, state: "lit", prompt: "Currency", advanced: false, enum: ["USDC"], default: "USDC", auto_fill: "USDC", help: null },
    { field: "network", group: "A", type: "enum", required: true, state: "lit", prompt: "Network", advanced: false, enum: ["base"], default: "base", auto_fill: "base", help: null },
    { field: "kind", group: "B", type: "enum", required: true, state: "lit", prompt: "Pay-link kind", advanced: false, enum: ["invoice", "subscription", "donation"], default: "invoice", auto_fill: null, help: null },
    { field: "product_name", group: "D", type: "string", required: false, state: "lit", prompt: "Product / line label", advanced: false, enum: null, default: null, auto_fill: null, help: null },
  ],
};

/** Wrap supplied fields + schema auto-fills into the tagged `params` tree. */
function buildParams(
  fields: Record<string, unknown>,
  schema: PayLinkSchemaResponse,
  walletAddress: string,
): Record<string, LitValue> {
  const params: Record<string, LitValue> = {};
  for (const f of schema.fields) {
    let v: unknown = fields[f.field];
    if ((v === undefined || v === "") && f.auto_fill) {
      v = f.auto_fill === "wallet" ? walletAddress : f.auto_fill;
    }
    if (v !== undefined && v !== "") {
      params[f.field] = {
        state: "lit",
        value: f.field === "to" ? ethers.getAddress(String(v)) : stringifyNumbers(v),
      };
    }
  }
  // Advanced / non-descriptor fields pass through (numbers coerced to strings
  // so the templateHash matches the server's — see stringifyNumbers).
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in params) && v !== undefined && v !== "") {
      params[k] = { state: "lit", value: stringifyNumbers(v) };
    }
  }
  return params;
}

function extractLit(params: Record<string, LitValue>): PayLinkLit {
  const get = (k: string): string => {
    const e = params[k];
    if (!e) throw new Error(`internal: missing lit field ${k} after validation`);
    return String(e.value);
  };
  return {
    to: get("to"),
    amount: get("amount"),
    currency: get("currency"),
    network: get("network"),
    kind: get("kind"),
  };
}

/** Interactive collect loop: prompt, then batch-validate, re-prompt only gaps. */
async function ttyCollect(
  schema: PayLinkSchemaResponse,
  seed: Record<string, unknown>,
  apiBase: string,
  token: string,
  walletAddress: string,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { ...seed };

  // First pass: prompt visible (non-advanced, non-auto-filled) fields.
  for (const f of schema.fields) {
    if (f.advanced) continue;
    if (fields[f.field] !== undefined) continue;
    if (f.auto_fill) continue; // silently auto-filled (to/currency/network)
    const enumHint = f.enum ? dim(` (${f.enum.join("|")})`) : "";
    const optional = f.required ? "" : dim(" — optional, enter to skip");
    const ans = await promptLine(
      `${f.prompt}${enumHint}${optional}`,
      f.default ?? undefined,
    );
    if (ans) fields[f.field] = ans;
  }

  // Batch-validate loop: one round-trip, show all gaps, re-prompt only those.
  for (;;) {
    const params = buildParams(fields, schema, walletAddress);
    const v = await validateLink(apiBase, token, params);
    if (v.ok) return fields;
    const gaps = [...v.missing, ...v.errors];
    console.log(yellow("\nStill needed:"));
    for (const g of gaps) console.log(`  ${dim("-")} ${g.field}: ${g.message}`);
    for (const g of gaps) {
      const sf = schema.fields.find((x) => x.field === g.field);
      const ans = await promptLine(
        g.prompt ?? sf?.prompt ?? `Value for ${g.field}`,
        sf?.default ?? undefined,
      );
      if (ans) fields[g.field] = ans;
    }
  }
}

function summarize(lit: PayLinkLit): string {
  const amount = lit.amount === "open" ? "pay-what-you-want" : `$${lit.amount}`;
  return `${amount} ${lit.kind} → ${lit.to}`;
}

export function registerLinksCommands(program: Command): void {
  const links = program
    .command("links")
    .description("Manage your pay-links (list, get, create, revoke)");

  // --- list ---------------------------------------------------------------
  links
    .command("list")
    .description("List your pay-links (newest first)")
    .option("--limit <n>", "Page size (1-100)", "25")
    .option("--starting-after <id>", "Cursor: last link_id of the previous page")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const qs = new URLSearchParams();
        qs.set("limit", opts.limit);
        if (opts.startingAfter) qs.set("starting_after", opts.startingAfter);
        const res = await listLinks(apiBase, token, qs.toString());
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.links.length) {
          console.log(dim("No pay-links yet. Create one with `xenarch links create`."));
          return;
        }
        console.log(
          formatTable(
            ["Link ID", "Kind", "Status", "Amount", "Created"],
            res.links.map((l) => [
              l.link_id,
              l.kind,
              l.status === "active" ? green(l.status) : l.status === "revoked" ? red(l.status) : yellow(l.status),
              l.amount_usd === "open" ? dim("open") : usd(l.amount_usd),
              l.created_at,
            ]),
          ),
        );
        if (res.has_more) {
          console.log(dim(`  more… --starting-after ${res.next_cursor}`));
        }
      } catch (err) {
        fail(err);
      }
    });

  // --- get ----------------------------------------------------------------
  links
    .command("get <id>")
    .description("Show one pay-link's detail")
    .action(async (id: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const d = await getLinkDetail(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(d));
          return;
        }
        console.log(`${bold("Pay-link")} ${d.link_id}
  ${bold("Kind:")}    ${d.kind}
  ${bold("Status:")}  ${d.status === "active" ? green(d.status) : red(d.status)}
  ${bold("Created:")} ${d.created_at}
  ${bold("Expires:")} ${d.expires_at ?? dim("—")}${d.link ? `\n  ${bold("URL:")}     ${cyan(String(d.link))}` : ""}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- create -------------------------------------------------------------
  links
    .command("create")
    .description("Create a pay-link. No args → interactive prompt loop.")
    .option("--amount <usd>", "Amount in USDC, or 'open'")
    .option("--kind <kind>", "Pay-link kind (invoice, subscription, donation, …)")
    .option("--product-name <name>", "Product / line label")
    .option("--params <json>", "Full field→value JSON (non-interactive)")
    .option("--mode <mode>", "validate | create (non-interactive)", "create")
    .option("--confirm", "Confirm signing non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const config = await readConfig();
        const globals = cmd.optsWithGlobals();
        const rpcUrl = globals.rpcUrl ?? config.rpc_url;
        const token = await loadSession();
        if (!config.wallet) {
          throw new Error("No wallet configured. Run `xenarch wallet generate|import|connect`.");
        }
        const walletAddress = ethers.getAddress(config.wallet.address);

        let schema: PayLinkSchemaResponse;
        try {
          schema = await getLinkSchema(apiBase);
        } catch {
          schema = BUNDLED_SCHEMA;
        }

        // Seed fields from flags / --params.
        let fields: Record<string, unknown> = {};
        if (opts.params) {
          try {
            fields = JSON.parse(opts.params);
          } catch {
            throw new Error("--params must be a JSON object of field → value.");
          }
        }
        if (opts.amount) fields.amount = opts.amount;
        if (opts.kind) fields.kind = opts.kind;
        if (opts.productName) fields.product_name = opts.productName;

        const mode: "validate" | "create" =
          opts.mode === "validate" ? "validate" : "create";
        const interactive =
          Boolean(process.stdin.isTTY) &&
          !jsonOutput &&
          !opts.params &&
          mode === "create";

        if (interactive) {
          fields = await ttyCollect(schema, fields, apiBase, token, walletAddress);
        }

        const params = buildParams(fields, schema, walletAddress);
        const validation: PayLinkValidateResponse = await validateLink(
          apiBase,
          token,
          params,
        );

        // Validate mode, or any invalid body → emit the structured result.
        if (mode === "validate" || !validation.ok) {
          if (jsonOutput || !interactive) {
            console.log(
              JSON.stringify({ mode: "validate", ...validation, params }),
            );
            if (!validation.ok) process.exitCode = 1;
            return;
          }
          // Interactive create can't reach here (the loop guarantees ok).
          console.error(red("Validation failed:"));
          for (const g of [...validation.missing, ...validation.errors]) {
            console.error(`  - ${g.field}: ${g.message}`);
          }
          process.exitCode = 1;
          return;
        }

        // Valid + create mode → confirm signing, then sign + create.
        const lit = extractLit(params);
        if (jsonOutput || !interactive) {
          if (!opts.confirm) {
            console.log(
              JSON.stringify({
                needs_confirmation: true,
                action: "sign_pay_link",
                summary: summarize(lit),
                message:
                  "Signing authorizes these payment terms. Re-run with --confirm to sign and create.",
                params,
              }),
            );
            process.exitCode = 1;
            return;
          }
        } else {
          const ok = await confirmTier2(
            `Create and sign this pay-link: ${bold(summarize(lit))}. Signing authorizes the payment terms.`,
            opts,
          );
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }

        // Load a signer that can sign EIP-712. WalletConnect must connect fresh
        // in-process (a disk-restored WC session can't decrypt the signature
        // response — XEN-407); a local wallet signs directly.
        let signer;
        if (config.wallet.type === "walletconnect") {
          const conn = await connectWalletConnect(config, rpcUrl, {
            json: jsonOutput,
          });
          signer = conn.signer;
          if (!jsonOutput) {
            console.log(dim("Connected. Approve the signature request on your phone…"));
          }
        } else {
          signer = await loadSigner(rpcUrl);
        }

        const signed = await signPayLink(signer, params, lit);
        const idempotencyKey = newIdempotencyKey();
        const created = await createLink(
          apiBase,
          token,
          {
            params,
            nonce: signed.nonce,
            created_at: signed.created_at,
            signed_params: signed.signed_params,
          },
          idempotencyKey,
        );
        await recordIdempotency({ key: idempotencyKey, link_id: created.link_id });

        if (jsonOutput) {
          console.log(JSON.stringify(created));
          return;
        }
        console.log(`${green("Pay-link created.")}

  ${bold("URL:")}      ${cyan(created.link)}
  ${bold("Link ID:")}  ${created.link_id}
  ${bold("Webhook secret:")} ${dim(created.webhook_secret)} ${dim("(shown once)")}

  Share the URL, or pay it yourself with ${cyan(`xenarch pay-link ${created.link_id}`)}.`);
      } catch (err) {
        fail(err);
      }
    });

  // --- revoke -------------------------------------------------------------
  links
    .command("revoke <id>")
    .description("Revoke a pay-link — payers can no longer pay it (Tier-2)")
    .option("--confirm", "Confirm revocation non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const ok = await confirmTier2(
          `Revoke pay-link ${id}? Anyone holding the URL can no longer pay it.`,
          opts,
        );
        if (!ok) {
          process.exitCode = 1;
          return;
        }

        const r = await revokeLink(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Pay-link revoked.")} ${r.link_id}${r.revoked_at ? dim(` at ${r.revoked_at}`) : ""}`);
      } catch (err) {
        fail(err);
      }
    });
}
