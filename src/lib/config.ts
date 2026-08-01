import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliError } from "./errors.js";

export type ConfigFile = {
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

/** durango.sh is the canonical host. */
export const DEFAULT_BASE_URL = "https://durango.sh";

/**
 * Hosts that older CLI versions saved to config and that no longer serve the API
 * (heydurango.com now 404s — it is not an alias). A stored value is migrated in
 * place so upgrades don't strand the user on a dead host.
 */
const RETIRED_BASE_URLS = new Set([
  "https://heydurango.com",
  "https://www.heydurango.com",
  "http://heydurango.com",
  "http://www.heydurango.com",
]);

export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "durango-cli",
  "config.json",
);

export function readConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

export function writeConfig(config: ConfigFile) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

/**
 * Rewrite a retired stored host to the canonical one, in place, with a single
 * stderr notice. stdout is left untouched so the `--json` contract still holds.
 */
function migrateStoredBaseUrl(config: ConfigFile, stored: string) {
  process.stderr.write(
    `durango: config baseUrl ${stored} is no longer served; using ${DEFAULT_BASE_URL}.\n`,
  );
  try {
    writeConfig({ ...config, baseUrl: DEFAULT_BASE_URL });
  } catch {
    // A read-only config dir is not worth failing the command over.
  }
  return DEFAULT_BASE_URL;
}

/** Precedence: --base-url flag > DURANGO_BASE_URL > config file > default. */
export function resolveBaseUrl(override?: string) {
  const config = readConfig();
  const explicit = override || process.env.DURANGO_BASE_URL;
  if (explicit) return normalizeBaseUrl(String(explicit));

  const stored = config.baseUrl ? normalizeBaseUrl(String(config.baseUrl)) : "";
  if (!stored) return DEFAULT_BASE_URL;
  if (RETIRED_BASE_URLS.has(stored)) return migrateStoredBaseUrl(config, stored);
  return stored;
}

/** Precedence: --api-key flag > DURANGO_API_KEY > config file. */
export function resolveApiKey(override?: string) {
  const config = readConfig();
  const key = override || process.env.DURANGO_API_KEY || config.apiKey || "";
  if (!key) {
    throw new CliError(
      "Missing API key. Run: durango login (or set DURANGO_API_KEY / durango config set --api-key dgo_...)",
      { exitCode: 1, code: "missing_api_key" },
    );
  }
  return String(key);
}

/** Safe-to-print form of an API key, e.g. dgo_abcd…wxyz. */
export function maskApiKey(key: string) {
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
