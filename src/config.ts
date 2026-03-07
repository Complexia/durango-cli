import { randomUUID } from "node:crypto";
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
const MACHINE_IDENTITY_FILE = join(CONFIG_DIR, "machine.json");

type MachineIdentity = {
  version: 1;
  machineId: string;
  createdAt: number;
};

export const configPath = CONFIG_FILE;
export const configDir = CONFIG_DIR;

const isMachineIdentity = (value: unknown): value is MachineIdentity => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return maybe.version === 1 && typeof maybe.machineId === "string" && maybe.machineId.trim().length > 0;
};

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

export const readMachineId = async (): Promise<string | null> => {
  try {
    const contents = await readFile(MACHINE_IDENTITY_FILE, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    if (!isMachineIdentity(parsed)) {
      return null;
    }

    return parsed.machineId;
  } catch {
    return null;
  }
};

export const ensureMachineId = async (preferredMachineId?: string): Promise<string> => {
  const existing = await readMachineId();
  if (existing) {
    return existing;
  }

  const machineId = preferredMachineId?.trim() || randomUUID();
  const identity: MachineIdentity = {
    version: 1,
    machineId,
    createdAt: Date.now()
  };

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(MACHINE_IDENTITY_FILE, JSON.stringify(identity, null, 2), "utf8");
  return machineId;
};

export const clearConfig = async (): Promise<void> => {
  await rm(CONFIG_FILE, { force: true });
};
