import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ForgeCodeConfig } from "./types.js";

const CONFIG_DIR = join(homedir(), ".forgecode");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export async function readConfig(): Promise<ForgeCodeConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ForgeCodeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeConfig(config: ForgeCodeConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
