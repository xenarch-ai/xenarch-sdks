import { Command } from "commander";
import * as readline from "node:readline";
import { readConfig, writeConfig } from "../lib/config.js";
import { registerPublisher } from "../lib/api.js";
import { bold, green } from "../lib/output.js";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export function registerRegisterCommand(program: Command): void {
  program
    .command("register")
    .description("Register as a Xenarch publisher")
    .option("--email <email>", "Publisher email address")
    .option("--password <password>", "Account password (min 8 characters)")
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

      if (!password || password.length < 8) {
        console.error("Password must be at least 8 characters.");
        process.exitCode = 1;
        return;
      }

      try {
        const result = await registerPublisher(apiBase, email, password);

        // Store the API key in config
        const config = await readConfig();
        config.auth_token = result.api_key;
        await writeConfig(config);

        if (jsonOutput) {
          console.log(JSON.stringify({ id: result.id, api_key: result.api_key }));
          return;
        }

        console.log(`${green("Registered successfully.")}

  ${bold("Publisher ID:")} ${result.id}
  ${bold("API Key:")}      ${result.api_key}

  API key saved to ~/.xenarch/config.json`);
      } catch (err) {
        console.error(`Registration failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
