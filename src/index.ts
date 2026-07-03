#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type JsonObject = Record<string, unknown>;
type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
};

const DEFAULT_BASE_URL = "https://heydurango.com";
const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "durango-cli", "config.json");

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    if (arg.startsWith("--no-")) {
      options[arg.slice(5)] = false;
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.trim();
    const next = argv[index + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : next && !next.startsWith("--")
        ? (index += 1, next)
        : true;

    const current = options[key];
    if (current === undefined) {
      options[key] = value;
    } else if (Array.isArray(current)) {
      current.push(String(value));
    } else {
      options[key] = [String(current), String(value)];
    }
  }

  return { positionals, options };
}

function optionString(options: ParsedArgs["options"], key: string): string | undefined {
  const value = options[key];
  if (Array.isArray(value)) return value.at(-1);
  if (typeof value === "string") return value;
  return undefined;
}

function optionStrings(options: ParsedArgs["options"], key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

function optionBoolean(options: ParsedArgs["options"], key: string, fallback = false): boolean {
  const value = options[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "false" && value !== "0";
  return fallback;
}

function optionNumber(options: ParsedArgs["options"], key: string, fallback: number): number {
  const value = optionString(options, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${key} must be a number.`);
  }
  return parsed;
}

function readConfig(): JsonObject {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as JsonObject;
  } catch {
    return {};
  }
}

function writeConfig(config: JsonObject) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function getBaseUrl() {
  const config = readConfig();
  const value = process.env.DURANGO_BASE_URL || String(config.baseUrl || DEFAULT_BASE_URL);
  return value.replace(/\/+$/, "");
}

function getApiKey() {
  const config = readConfig();
  const key = process.env.DURANGO_API_KEY || String(config.apiKey || "");
  if (!key) {
    throw new CliError("Missing API key. Set DURANGO_API_KEY or run: durango config set --api-key dgo_...");
  }
  return key;
}

async function apiJson(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getApiKey()}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${getBaseUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(async () => ({ error: { message: await response.text() } }));
    const message = typeof body?.error?.message === "string"
      ? body.error.message
      : `${response.status} ${response.statusText}`;
    throw new CliError(message, response.status >= 500 ? 2 : 1);
  }
  return await response.json() as JsonObject;
}

async function apiDownload(urlOrPath: string) {
  const url = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")
    ? urlOrPath
    : `${getBaseUrl()}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(async () => ({ error: { message: await response.text() } }));
    const message = typeof body?.error?.message === "string"
      ? body.error.message
      : `${response.status} ${response.statusText}`;
    throw new CliError(message, response.status >= 500 ? 2 : 1);
  }
  return response;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireOption(options: ParsedArgs["options"], key: string) {
  const value = optionString(options, key);
  if (!value) throw new CliError(`Missing --${key}.`);
  return value;
}

function extensionFromContentType(contentType: string, fallback: string) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4")) return "mp4";
  return fallback;
}

async function writeResponseToFile(response: Response, outputPath: string) {
  const data = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, data);
  process.stderr.write(`Wrote ${outputPath}\n`);
}

async function commandConfig(args: ParsedArgs) {
  const action = args.positionals[1];
  if (action !== "set") {
    throw new CliError("Usage: durango config set [--api-key dgo_...] [--base-url https://...]");
  }
  const config = readConfig();
  const apiKey = optionString(args.options, "api-key");
  const baseUrl = optionString(args.options, "base-url");
  if (!apiKey && !baseUrl) {
    throw new CliError("Pass --api-key, --base-url, or both.");
  }
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseUrl = baseUrl.replace(/\/+$/, "");
  writeConfig(config);
  process.stdout.write(`Saved ${CONFIG_PATH}\n`);
}

async function commandCredits() {
  printJson(await apiJson("/api/v1/credits"));
}

async function commandModels(args: ParsedArgs) {
  if (args.positionals[1] !== "list") {
    throw new CliError("Usage: durango models list [--type chat|image|video]");
  }
  const type = optionString(args.options, "type");
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  printJson(await apiJson(`/api/v1/models${query}`));
}

async function downloadGeneratedAsset(data: unknown, outputPath: string, fallbackExtension: string) {
  if (!data || typeof data !== "object") {
    throw new CliError("Generation response did not include downloadable data.");
  }
  const items = (data as JsonObject).data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new CliError("Generation response did not include downloadable data.");
  }

  const first = items[0] as JsonObject;
  if (typeof first.b64_json === "string") {
    const contentType = typeof first.content_type === "string" ? first.content_type : "";
    const extension = extensionFromContentType(contentType, fallbackExtension);
    const finalPath = outputPath.includes(".") ? outputPath : `${outputPath}.${extension}`;
    writeFileSync(finalPath, Buffer.from(first.b64_json, "base64"));
    process.stderr.write(`Wrote ${finalPath}\n`);
    return;
  }

  if (typeof first.url !== "string") {
    throw new CliError("Generation response did not include a download URL.");
  }
  await writeResponseToFile(await apiDownload(first.url), outputPath);
}

async function commandImage(args: ParsedArgs) {
  if (args.positionals[1] !== "generate") {
    throw new CliError("Usage: durango image generate --model <id> --prompt <text> [--out image.png]");
  }

  const outputPath = optionString(args.options, "out");
  const responseFormat = outputPath ? "b64_json" : optionString(args.options, "response-format") || "url";
  const body = {
    model: requireOption(args.options, "model"),
    prompt: requireOption(args.options, "prompt"),
    aspect_ratio: optionString(args.options, "aspect-ratio") || "1:1",
    image_size: optionString(args.options, "image-size") || "1K",
    response_format: responseFormat,
    source_images: optionStrings(args.options, "source-image"),
    private: optionBoolean(args.options, "private"),
  };

  const result = await apiJson("/api/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (outputPath) {
    await downloadGeneratedAsset(result, outputPath, "png");
    return;
  }
  printJson(result);
}

async function pollVideoRun(runIdOrUrl: string, intervalMs: number, timeoutMs: number) {
  const startedAt = Date.now();
  const path = runIdOrUrl.startsWith("http://") || runIdOrUrl.startsWith("https://")
    ? new URL(runIdOrUrl).pathname
    : `/api/v1/videos/generations/${runIdOrUrl}`;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await apiJson(path);
    if (status.status === "completed" || status.status === "failed") {
      return status;
    }
    process.stderr.write(`Video status: ${String(status.status || "running")}\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new CliError("Timed out waiting for video generation.");
}

async function commandVideo(args: ParsedArgs) {
  const action = args.positionals[1];
  if (action === "status") {
    const runId = args.positionals[2];
    if (!runId) throw new CliError("Usage: durango video status <runId>");
    printJson(await apiJson(`/api/v1/videos/generations/${runId}`));
    return;
  }

  if (action !== "generate") {
    throw new CliError("Usage: durango video generate --model <id> --prompt <text> [--out video.mp4]");
  }

  const body: JsonObject = {
    model: requireOption(args.options, "model"),
    prompt: requireOption(args.options, "prompt"),
    aspect_ratio: optionString(args.options, "aspect-ratio") || "16:9",
    resolution: optionString(args.options, "resolution") || "720p",
    duration: optionNumber(args.options, "duration", 5),
    source_images: optionStrings(args.options, "source-image"),
    source_image_ids: optionStrings(args.options, "source-image-id"),
    private: optionBoolean(args.options, "private"),
  };
  const modelIds = optionStrings(args.options, "model-id");
  if (modelIds.length > 0) body.model_ids = modelIds;
  if (args.options.audio !== undefined) body.generate_audio = optionBoolean(args.options, "audio");

  const started = await apiJson("/api/v1/videos/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const wait = optionBoolean(args.options, "wait", true);
  if (!wait) {
    printJson(started);
    return;
  }

  const runId = String(started.id || "");
  if (!runId) throw new CliError("Video generation did not return a run id.");
  const final = await pollVideoRun(
    runId,
    optionNumber(args.options, "poll-interval", 12) * 1000,
    optionNumber(args.options, "timeout", 30) * 60 * 1000,
  );

  if (final.status === "failed") {
    throw new CliError(typeof final.error === "string" ? final.error : "Video generation failed.");
  }

  const outputPath = optionString(args.options, "out");
  if (outputPath) {
    await downloadGeneratedAsset(final, outputPath, "mp4");
    return;
  }
  printJson(final);
}

async function commandDownload(args: ParsedArgs) {
  const target = args.positionals[1];
  if (!target) {
    throw new CliError("Usage: durango download <url-or-id> --type image|video --out <path>");
  }
  const outputPath = requireOption(args.options, "out");
  const type = optionString(args.options, "type");
  const path = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("/api/")
    ? target
    : type === "image"
      ? `/api/v1/images/${target}`
      : type === "video"
        ? `/api/v1/videos/${target}`
        : target;
  await writeResponseToFile(await apiDownload(path), outputPath);
}

function help() {
  process.stdout.write(`durango-cli

Usage:
  durango config set [--api-key dgo_...] [--base-url https://heydurango.com]
  durango credits
  durango models list [--type chat|image|video]
  durango image generate --model <id> --prompt <text> [--out image.png]
  durango video generate --model <id> --prompt <text> [--out video.mp4]
  durango video status <runId>
  durango download <url-or-id> --type image|video --out <path>

Environment:
  DURANGO_API_KEY    API key created in Durango settings
  DURANGO_BASE_URL   Defaults to ${DEFAULT_BASE_URL}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (!command || command === "help" || args.options.help === true || args.options.h === true) {
    help();
    return;
  }

  if (command === "config") return await commandConfig(args);
  if (command === "credits") return await commandCredits();
  if (command === "models") return await commandModels(args);
  if (command === "image") return await commandImage(args);
  if (command === "video") return await commandVideo(args);
  if (command === "download") return await commandDownload(args);

  throw new CliError(`Unknown command: ${command}`);
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`durango: ${error.message}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write(`durango: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
