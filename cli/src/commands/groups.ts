import { Command } from "commander";
import { listGroups, createGroup, updateGroup, deleteGroup } from "../lib/api.js";
import {
  ctx,
  resolveApiBase,
  loadSession,
  confirmMutation,
  fail,
} from "../lib/cmd-common.js";
import { green, dim, formatTable } from "../lib/output.js";
import type { GroupUpdateBody } from "../types.js";

export function registerGroupsCommands(program: Command): void {
  const groups = program
    .command("groups")
    .description("Organize pay-links into groups");

  // --- list ---------------------------------------------------------------
  groups
    .command("list")
    .description("List your pay-link groups")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const res = await listGroups(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(res));
          return;
        }
        if (!res.groups.length) {
          console.log(dim("No groups. Create one with `xenarch groups create <name>`."));
          return;
        }
        console.log(
          formatTable(
            ["ID", "Name", "Accent", "Pos", "Links"],
            res.groups.map((g) => [
              g.id,
              g.name,
              g.accent_kind,
              String(g.position),
              String(g.member_count),
            ]),
          ),
        );
      } catch (err) {
        fail(err);
      }
    });

  // --- create -------------------------------------------------------------
  groups
    .command("create <name>")
    .description("Create a pay-link group (Tier-2)")
    .option("--accent <kind>", "Accent kind (e.g. empty)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (name: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Create group "${name}"?`,
          "create_group",
          opts,
        );
        if (!ok) return;
        const g = await createGroup(apiBase, token, {
          name,
          ...(opts.accent ? { accent_kind: opts.accent } : {}),
        });
        if (jsonOutput) {
          console.log(JSON.stringify(g));
          return;
        }
        console.log(`${green("Group created.")} ${g.id} ${dim(g.name)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- rename (and reposition/recolor) ------------------------------------
  groups
    .command("rename <id> <name>")
    .description("Rename a group (or set --accent / --position) (Tier-2)")
    .option("--accent <kind>", "New accent kind")
    .option("--position <n>", "Absolute position in the list (0-indexed)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, name: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const body: GroupUpdateBody = { name };
        if (opts.accent) body.accent_kind = opts.accent;
        if (opts.position !== undefined) {
          const pos = Number(opts.position);
          if (!Number.isInteger(pos) || pos < 0) {
            throw new Error("--position must be a non-negative integer.");
          }
          body.position = pos;
        }
        const ok = await confirmMutation(
          jsonOutput,
          `Update group ${id}?`,
          "update_group",
          opts,
        );
        if (!ok) return;
        const g = await updateGroup(apiBase, token, id, body);
        if (jsonOutput) {
          console.log(JSON.stringify(g));
          return;
        }
        console.log(`${green("Group updated.")} ${g.id} ${dim(g.name)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- rm -----------------------------------------------------------------
  groups
    .command("rm <id>")
    .description("Delete a group — its links become ungrouped (Tier-2)")
    .option("--confirm", "Confirm non-interactively")
    .action(async (id: string, opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const ok = await confirmMutation(
          jsonOutput,
          `Delete group ${id}? Its links move to ungrouped.`,
          "delete_group",
          opts,
        );
        if (!ok) return;
        await deleteGroup(apiBase, token, id);
        if (jsonOutput) {
          console.log(JSON.stringify({ deleted: true, id }));
          return;
        }
        console.log(`${green("Group deleted.")} ${id}`);
      } catch (err) {
        fail(err);
      }
    });
}
