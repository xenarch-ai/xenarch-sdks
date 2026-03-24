import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

function defaultConfigDir(): string {
  return join(homedir(), ".xenarch");
}

export async function ensureConfigDir(configDir?: string): Promise<string> {
  const dir = configDir ?? defaultConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readConfig(configDir?: string): Promise<Config> {
  const dir = configDir ?? defaultConfigDir();
  const filePath = join(dir, "config.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    // Migrate legacy wallets without type field
    if (parsed.wallet && !parsed.wallet.type) {
      parsed.wallet = { ...parsed.wallet, type: "local" };
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
}

export async function writeConfig(
  config: Config,
  configDir?: string,
): Promise<void> {
  const dir = await ensureConfigDir(configDir);
  const filePath = join(dir, "config.json");
  await writeFile(filePath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}
