#!/usr/bin/env node
// Live end-to-end check for @xenarch/sdk against api.xenarch.dev.
//
// Exercises the whole merchant surface + webhooks against the real platform.
// Nothing moves USDC — it creates/reads/revokes a pay-link (signed template +
// REST), so it's free and safe against production. The create call is the
// signing-parity proof: the platform recovers the EIP-712 signature and
// rejects any mismatch.
//
// Prereqs (same as the Python SDK e2e):
//   1. A local-key wallet + session:  xenarch wallet generate && xenarch agent login
//   2. Build the SDK:                 npm run build
//   3. Run:                           node scripts/e2e.mjs
//
// Reads ~/.xenarch/config.json (the CLI's session + wallet) via Xenarch.fromConfig().

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Xenarch, ConfirmationRequired, webhooks } from "../dist/index.js";

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const SKIP = "\x1b[33mSKIP\x1b[0m";
let passed = 0;
let failed = 0;

async function step(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [${PASS}] ${label}`);
  } catch (err) {
    failed++;
    console.log(`  [${FAIL}] ${label}\n         ${err?.name}: ${err?.message}`);
  }
}

const cfg = JSON.parse(
  await readFile(join(homedir(), ".xenarch", "config.json"), "utf-8").catch(() => "{}"),
);
const wallet = cfg.wallet ?? {};
console.log(`Platform: ${cfg.api_base ?? "https://api.xenarch.dev"}`);
console.log(`Wallet:   ${wallet.address ?? "(none)"} (${wallet.type ?? "none"})`);
console.log(`Session:  ${cfg.session_token ? "present" : "MISSING"}\n`);

const sdk = await Xenarch.fromConfig();
const canSign = Boolean(wallet.private_key && wallet.address);

console.log("── Read-only merchant surface ──");
await step("merchant.profile.show()", async () => void (await sdk.merchant.profile.show()));
await step("merchant.links.list()", async () => {
  const r = await sdk.merchant.links.list({ limit: 5 });
  console.log(`         ${r.links.length} links (has_more=${r.has_more})`);
});
await step("merchant.payments.list()", async () => {
  const r = await sdk.merchant.payments.list({ limit: 5 });
  console.log(`         ${r.payments.length} payments`);
});
await step("merchant.subscribers.list()", async () => {
  const r = await sdk.merchant.subscribers.list({ limit: 5 });
  console.log(`         ${r.subscribers.length} subscribers`);
});
await step("merchant.links.schema()", async () => {
  const r = await sdk.merchant.links.schema();
  console.log(`         schema: ${r.fields.length} fields, version=${r.version}`);
});

console.log("\n── Confirm gate ──");
await step("create without confirm is refused (ConfirmationRequired)", async () => {
  try {
    await sdk.merchant.links.create({});
  } catch (err) {
    if (err instanceof ConfirmationRequired) return;
    throw err;
  }
  throw new Error("expected ConfirmationRequired");
});

if (!canSign) {
  console.log(`\n[${SKIP}] create/get/revoke — no local signing key in config`);
} else {
  const params = {
    to: { state: "lit", value: wallet.address },
    amount: { state: "lit", value: "0.10" },
    currency: { state: "lit", value: "USDC" },
    network: { state: "lit", value: "base" },
    kind: { state: "lit", value: "checkout" },
  };
  console.log("\n── Validate → sign → create (signing parity) ──");
  await step("merchant.links.validate(params)", async () => {
    const v = await sdk.merchant.links.validate(params);
    console.log(`         ok=${v.ok} missing=${v.missing.length} errors=${v.errors.length}`);
  });

  let created;
  await step("merchant.links.create({confirm:true})  ← platform verifies the signature", async () => {
    created = await sdk.merchant.links.create(params, { confirm: true });
    console.log(`         link_id=${created.link_id}`);
    console.log(`         link=${created.link}`);
    console.log(`         webhook_secret=${created.webhook_secret ? "whsec_…" : "none"}`);
  });

  if (created) {
    await step(`merchant.links.get(${created.link_id})`, async () => {
      const d = await sdk.merchant.links.get(created.link_id);
      console.log(`         status=${d.status} kind=${d.kind}`);
    });
    if (created.webhook_secret) {
      await step("webhooks.verify() round-trip on returned secret", async () => {
        const body = '{"event_type":"payment.received","link_id":"e2e","data":{}}';
        const sig = await webhooks.computeSignature(body, created.webhook_secret);
        if (!(await webhooks.verify(body, sig, created.webhook_secret)))
          throw new Error("verify rejected a signature it just computed");
        if (await webhooks.verify(body, sig, "whsec_wrong"))
          throw new Error("verify accepted a wrong secret");
      });
    }
    await step(`merchant.links.revoke(${created.link_id}, {confirm:true})`, async () => {
      await sdk.merchant.links.revoke(created.link_id, { confirm: true });
    });
  }
}

console.log(`\n${"─".repeat(48)}\nE2E: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
