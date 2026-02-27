import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CliConfig = {
  machineId: string;
  userId: string;
  token: string;
  relayUrl: string;
  webUrl: string;
};

const CONFIG_DIR = process.env.DURANGO_CONFIG_DIR || join(homedir(), ".durango");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const configPath = CONFIG_FILE;
export const configDir = CONFIG_DIR;

export const readConfig = async (): Promise<CliConfig | null> => {
  try {
    const contents = await readFile(CONFIG_FILE, "utf8");
    return JSON.parse(contents) as CliConfig;
  } catch {
    return null;
  }
};

export const writeConfig = async (config: CliConfig): Promise<void> => {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
};

export const clearConfig = async (): Promise<void> => {
  await rm(CONFIG_FILE, { force: true });
};
