import { Command } from "commander";
import * as readline from "node:readline";
import { readConfig, writeConfig } from "../lib/config.js";
import { loginPublisher } from "../lib/api.js";
import { bold, green, yellow } from "../lib/output.js";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Log in to your Xenarch publisher account")
    .option("--email <email>", "Publisher email address")
    .option("--password <password>", "Account password")
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const jsonOutput: boolean = globals.json ?? false;
      const apiBase: string = globals.apiBase ?? (await readConfig()).api_base;

      let email: string = opts.email;
      let password: string = opts.password;

      if (!email || !password) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        if (!email) {
          email = await prompt(rl, "Email: ");
        }
        if (!password) {
          password = await prompt(rl, "Password: ");
        }
        rl.close();
      }

      if (!email) {
        console.error("Email is required.");
        process.exitCode = 1;
        return;
      }

      if (!password) {
        console.error("Password is required.");
        process.exitCode = 1;
        return;
      }

      try {
        const result = await loginPublisher(apiBase, email, password);

        // Store the API key in config
        const config = await readConfig();
        config.auth_token = result.api_key;
        await writeConfig(config);

        if (jsonOutput) {
          console.log(JSON.stringify({ api_key: result.api_key }));
          return;
        }

        console.log(`${green("Logged in successfully.")}

  ${bold("API Key:")} ${result.api_key}

  API key saved to ~/.xenarch/config.json

  ${yellow("Note:")} This rotated your API key. If you use the WordPress plugin,
  update it in Settings → Xenarch with the new key above.`);
      } catch (err) {
        console.error(`Login failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
