import { Command } from "commander";
import { getPublisherGating, putPublisherGating } from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
} from "../lib/cmd-common.js";
import { bold, green, red, dim } from "../lib/output.js";
import type { PublisherGating, PublisherGatingBody } from "../types.js";

function render(g: PublisherGating): void {
  console.log(`${bold("Publisher gating:")} ${g.gating_enabled ? green("enabled") : dim("disabled")}`);
  for (const [cat, gated] of Object.entries(g.gated_categories)) {
    console.log(`  ${gated ? red("gated ") : green("allow ")} ${cat}`);
  }
  const overrides = Object.entries(g.bot_overrides);
  if (overrides.length) {
    console.log(bold("  Overrides:"));
    for (const [sig, mode] of overrides) console.log(`    ${sig} → ${mode}`);
  }
}

export function registerGatingCommands(program: Command): void {
  const gating = program
    .command("gating")
    .description("Publisher-level gating defaults");

  gating
    .command("defaults")
    .description("Show or set publisher gating defaults. No set-flags → show.")
    .option("--enable", "Enable gating by default")
    .option("--disable", "Disable gating by default")
    .option("--categories <json>", "Full category→bool map (must cover all categories)")
    .option("--overrides <json>", "Per-signature allow/charge map, e.g. '{\"GPTBot\":\"charge\"}'")
    .option("--confirm", "Confirm the change non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const isSet = opts.enable || opts.disable || opts.categories || opts.overrides;
        const current = await getPublisherGating(apiBase, token);
        if (!isSet) {
          if (jsonOutput) {
            console.log(JSON.stringify(current));
            return;
          }
          render(current);
          return;
        }
        if (opts.enable && opts.disable) {
          throw new Error("Pass only one of --enable / --disable.");
        }
        let categories = current.gated_categories;
        if (opts.categories) {
          try {
            categories = JSON.parse(opts.categories);
          } catch {
            throw new Error("--categories must be a JSON object of category → bool.");
          }
        }
        const body: PublisherGatingBody = {
          gating_enabled: opts.enable ? true : opts.disable ? false : current.gating_enabled,
          gated_categories: categories,
        };
        if (opts.overrides) {
          try {
            body.bot_overrides = JSON.parse(opts.overrides);
          } catch {
            throw new Error("--overrides must be a JSON object of signature → allow|charge.");
          }
        }
        const ok = await confirmMutation(
          jsonOutput,
          "Update publisher gating defaults? This affects every site using publisher defaults.",
          "set_publisher_gating",
          opts,
        );
        if (!ok) return;
        const r = await putPublisherGating(apiBase, token, body);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(green("Publisher gating updated."));
        render(r);
      } catch (err) {
        fail(err);
      }
    });
}
