import { Command } from "commander";
import { setOnboardingEmail, verifyOnboardingEmail, getEarningsSummary } from "../lib/api.js";
import { ctx, resolveApiBase, loadSession, fail, usd } from "../lib/cmd-common.js";
import { bold, green, dim } from "../lib/output.js";

export function registerAccountCommands(program: Command): void {
  // --- email (set + verify OTP) -------------------------------------------
  const email = program
    .command("email")
    .description("Set and verify your account email");

  email
    .command("set <email>")
    .description("Send a verification code to an email for your account")
    .action(async (address: string, _opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await setOnboardingEmail(apiBase, token, address);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Code sent.")} ${r.email} ${dim(r.sent ? "" : "(not sent)")}
  Enter it with ${bold(`xenarch email verify --code <code>`)}.`);
      } catch (err) {
        fail(err);
      }
    });

  email
    .command("verify")
    .description("Verify your account email with the code you received")
    .requiredOption("--code <code>", "4-digit verification code")
    .action(async (opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await verifyOnboardingEmail(apiBase, token, opts.code);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        console.log(`${green("Email verified.")} ${r.email} ${dim(`at ${r.email_verified_at}`)}`);
      } catch (err) {
        fail(err);
      }
    });

  // --- earnings -----------------------------------------------------------
  program
    .command("earnings")
    .description("Merged gating + pay-link earnings (today / month / all-time)")
    .action(async (_opts, cmd: Command) => {
      try {
        const apiBase = await resolveApiBase(cmd);
        const { jsonOutput } = ctx(cmd, apiBase);
        const token = await loadSession();
        const r = await getEarningsSummary(apiBase, token);
        if (jsonOutput) {
          console.log(JSON.stringify(r));
          return;
        }
        const line = (label: string, b: { earned_usd: string; payment_count: number }) =>
          `  ${bold(label.padEnd(9))} ${usd(b.earned_usd)} ${dim(`(${b.payment_count} payments)`)}`;
        console.log(bold("Earnings"));
        console.log(line("Today:", r.today));
        console.log(line("Month:", r.month));
        console.log(line("All-time:", r.all_time));
      } catch (err) {
        fail(err);
      }
    });
}
