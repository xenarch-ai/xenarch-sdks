import { Command } from "commander";
import { createInvite, listInvites, revokeInvite } from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
} from "../lib/cmd-common.js";
import { bold, green, cyan, dim, formatTable } from "../lib/output.js";
import type { InviteCreateBody } from "../types.js";

const ROLES = ["viewer", "operator", "full_co_owner"];

export function registerInvitesCommands(program: Command): void {
  const invite = program
    .command("invite")
    .description("Invite wallets to co-own your account");

  // Note: `invite redeem <token>` (SIWE-sign to join) lands in a follow-up —
  // it needs a loaded signer + live wallet validation.

  // --- create -------------------------------------------------------------
  invite
    .command("create")
    .description("Mint an invite link for a wallet to join your account (Tier-2)")
    .option("--label <label>", "Nickname for the joining wallet")
    .option("--role <role>", "viewer | operator | full_co_owner", "operator")
    .option("--confirm", "Confirm non-interactively")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        if (opts.role && !ROLES.includes(opts.role)) {
          throw new Error(`--role must be one of: ${ROLES.join(", ")}.`);
        }
        const ok = await confirmMutation(
          jsonOutput,
          `Mint an invite (role: ${opts.role})? Anyone with the link can join your account.`,
          "create_invite",
          opts,
        );
        if (!ok) return;
        const body: InviteCreateBody = {
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.role ? { role: opts.role } : {}),
        };
        const r = await createInvite(apiBase, token, body);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Invite minted.")}
  ${bold("Join URL:")} ${cyan(r.join_url)}
  ${bold("Token:")}    ${r.token} ${dim("(shown once)")}
  ${bold("Role:")}     ${r.role}
  ${bold("Expires:")}  ${r.expires_at}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- list ---------------------------------------------------------------
  invite
    .command("list")
    .description("List your live invites")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const res = await listInvites(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.invites.length) {
          console.log(dim("No live invites."));
          return;
        }
        console.log(
          formatTable(
            ["ID", "Label", "Role", "Created by", "Expires"],
            res.invites.map((i) => [
              i.id,
              i.label ?? dim("—"),
              i.role,
              `${i.created_by_wallet.slice(0, 10)}…`,
              i.expires_at,
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- revoke -------------------------------------------------------------
  invite
    .command("revoke <id>")
    .description("Revoke a live invite before it's redeemed (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Revoke invite ${id}? Its join link stops working.`,
          "revoke_invite",
          opts,
        );
        if (!ok) return;
        await revokeInvite(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify({ revoked: true, id }));
          return;
        }
        console.log(`${green("Invite revoked.")} ${id}`);
      } catch (err) {
        fail(err);
      }
    });
}
