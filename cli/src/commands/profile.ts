import { Command } from "commander";
import {
  getMerchantProfile,
  putMerchantProfile,
  verifyMerchantDomain,
} from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail } from "../lib/cmd-common.js";
import { bold, green, yellow, dim, cyan } from "../lib/output.js";
import type { MerchantProfileBody, MerchantProfileResponse } from "../types.js";

/** Pull only the writable fields off a profile (PUT is a whole-state upsert). */
function writableFields(p: MerchantProfileResponse | null): MerchantProfileBody {
  if (!p) return {};
  return {
    issuer_name: p.issuer_name ?? null,
    issuer_logo_url: p.issuer_logo_url ?? null,
    issuer_address: p.issuer_address ?? null,
    issuer_tax_id: p.issuer_tax_id ?? null,
    issuer_email: p.issuer_email ?? null,
    merchant_site: p.merchant_site ?? null,
    brand_color: p.brand_color ?? null,
    collection_rhythm: p.collection_rhythm ?? null,
  };
}

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command("profile")
    .description("Your merchant profile (issuer identity, domain verification)");

  // --- show ---------------------------------------------------------------
  profile
    .command("show")
    .description("Show your merchant profile")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const p = await getMerchantProfile(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(p));
          return;
        }
        if (!p) {
          console.log(dim("No merchant profile yet. Set one with `xenarch profile update`."));
          return;
        }
        const verified = p.domain_verified_at
          ? green(`verified ${p.domain_verified_at}`)
          : yellow("unverified");
        console.log(`${bold("Merchant profile")}
  ${bold("Issuer:")}   ${p.issuer_name ?? dim("—")}
  ${bold("Site:")}     ${p.merchant_site ?? dim("—")} (${verified})
  ${bold("Email:")}    ${p.issuer_email ?? dim("—")}
  ${bold("Address:")}  ${p.issuer_address ?? dim("—")}
  ${bold("Tax ID:")}   ${p.issuer_tax_id ?? dim("—")}
  ${bold("Brand:")}    ${p.brand_color ?? dim("—")}
  ${bold("Payouts:")}  ${p.collection_rhythm ?? dim("—")}`);
        if (!p.domain_verified_at && p.merchant_site) {
          console.log(`
  To verify ${bold(p.merchant_site)}, add a DNS TXT record at ${cyan(`_xenarch.${p.merchant_site}`)}:
    ${cyan(`xenarch-verify=${p.verification_token}`)}
  then run ${cyan("xenarch profile verify-domain")}.`);
        }
      } catch (err) {
        fail(err);
      }
    });

  // --- update -------------------------------------------------------------
  profile
    .command("update")
    .description("Update your merchant profile (only the flags you pass change)")
    .option("--issuer-name <name>", "Business name shown on receipts")
    .option("--merchant-site <domain>", "Your domain (e.g. example.com)")
    .option("--issuer-email <email>", "Reply-to for receipt emails")
    .option("--issuer-address <address>", "Postal address")
    .option("--issuer-tax-id <id>", "VAT / EIN / GST")
    .option("--brand-color <hex>", "Accent color, e.g. #5a9fd4")
    .option("--logo-url <url>", "HTTPS logo URL (must match your domain)")
    .option("--collection-rhythm <rhythm>", "daily | weekly | monthly | never")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();

        const current = await getMerchantProfile(apiBase, token);
        const body = writableFields(current);
        if (opts.issuerName !== undefined) body.issuer_name = opts.issuerName;
        if (opts.merchantSite !== undefined) body.merchant_site = opts.merchantSite;
        if (opts.issuerEmail !== undefined) body.issuer_email = opts.issuerEmail;
        if (opts.issuerAddress !== undefined) body.issuer_address = opts.issuerAddress;
        if (opts.issuerTaxId !== undefined) body.issuer_tax_id = opts.issuerTaxId;
        if (opts.brandColor !== undefined) body.brand_color = opts.brandColor;
        if (opts.logoUrl !== undefined) body.issuer_logo_url = opts.logoUrl;
        if (opts.collectionRhythm !== undefined) {
          body.collection_rhythm = opts.collectionRhythm;
        }

        const updated = await putMerchantProfile(apiBase, token, body);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Profile updated.")} ${updated.issuer_name ?? ""} ${dim(`(${updated.merchant_site ?? "no site"})`)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- verify-domain (XEN-394) -------------------------------------------
  profile
    .command("verify-domain")
    .description("Verify your merchant_site via its DNS TXT record")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const updated = await verifyMerchantDomain(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(updated));
          return;
        }
        console.log(`${green("Domain verified.")} ${updated.merchant_site} at ${updated.domain_verified_at}`);
      } catch (err) {
        fail(err);
      }
    });
}
