import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { resolveApiKey, resolveBaseUrl } from "./config.js";
import { CliError, invalidResponse } from "./errors.js";

export type JsonObject = Record<string, unknown>;

/** RequestInit plus a per-request abort budget. */
export type RequestOptions = RequestInit & { timeoutMs?: number };

const DEFAULT_JSON_TIMEOUT_MS = 120_000;

/**
 * Uploads and downloads move gigabytes; a 2 minute cap would kill healthy
 * transfers, so they only guard against a peer that never finishes at all.
 */
export const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

/** Per-request timeout for JSON calls. Override with DURANGO_HTTP_TIMEOUT_MS. */
export function jsonTimeoutMs() {
  const raw = process.env.DURANGO_HTTP_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JSON_TIMEOUT_MS;
}

function isAbort(error: unknown) {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function failure(response: Response): Promise<CliError> {
  const text = await response.text().catch(() => "");
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;

  try {
    const body = JSON.parse(text) as JsonObject;
    const envelope = body.error;
    if (envelope && typeof envelope === "object") {
      const inner = envelope as JsonObject;
      if (typeof inner.message === "string" && inner.message) message = inner.message;
      if (typeof inner.code === "string" && inner.code) code = inner.code;
    } else if (typeof envelope === "string" && envelope) {
      message = envelope;
    } else if (typeof body.message === "string" && body.message) {
      message = body.message;
    }
  } catch {
    if (text.trim()) message = text.trim().slice(0, 500);
  }

  return new CliError(message, {
    exitCode: response.status >= 500 ? 2 : 1,
    code: code || `http_${response.status}`,
  });
}

function isJsonBody(body: BodyInit | null | undefined) {
  return typeof body === "string";
}

/** fetch with a mandatory abort budget; aborts surface as `timeout` CliErrors. */
async function send(url: string, init: RequestOptions, fallbackTimeoutMs: number): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : fallbackTimeoutMs;
  try {
    return await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(budget) });
  } catch (error) {
    if (isAbort(error)) {
      throw new CliError(`Request timed out after ${Math.round(budget / 1000)}s: ${url}`, {
        exitCode: 2,
        code: "timeout",
      });
    }
    throw error;
  }
}

/** A 2xx body that will not parse is a server problem, not a usage problem. */
async function readJson(response: Response, url: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) {
      throw new CliError(`Response body timed out: ${url}`, { exitCode: 2, code: "timeout" });
    }
    throw error;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    throw invalidResponse(
      `Durango returned a ${response.status} response that is not valid JSON (${url}).`,
    );
  }
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export function createHttpClient(overrides: { baseUrl?: string; apiKey?: string } = {}) {
  let cachedBaseUrl: string | undefined;
  let cachedKey: string | undefined;

  /**
   * Resolved on first use, not at construction: reading the config can rewrite a
   * retired host in place, and `durango help` / `--version` must not touch the
   * config file at all.
   */
  const resolvedBaseUrl = () => {
    if (cachedBaseUrl === undefined) cachedBaseUrl = resolveBaseUrl(overrides.baseUrl);
    return cachedBaseUrl;
  };

  const apiKey = () => {
    if (cachedKey === undefined) cachedKey = resolveApiKey(overrides.apiKey);
    return cachedKey;
  };

  const absolute = (urlOrPath: string) =>
    urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")
      ? urlOrPath
      : `${resolvedBaseUrl()}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;

  /** Authenticated JSON request. */
  const json = async (path: string, init: RequestOptions = {}): Promise<JsonObject> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey()}`);
    if (isJsonBody(init.body) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const url = absolute(path);
    const response = await send(url, { ...init, headers }, jsonTimeoutMs());
    if (!response.ok) throw await failure(response);
    return await readJson(response, url);
  };

  /** Unauthenticated JSON request (device-code login endpoints). */
  const publicJson = async (path: string, init: RequestOptions = {}): Promise<JsonObject> => {
    const headers = new Headers(init.headers);
    if (isJsonBody(init.body) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const url = absolute(path);
    const response = await send(url, { ...init, headers }, jsonTimeoutMs());
    if (!response.ok) throw await failure(response);
    return await readJson(response, url);
  };

  /** Authenticated byte fetch, used for downloads. The body is streamed by the caller. */
  const download = async (urlOrPath: string): Promise<Response> => {
    const response = await send(
      absolute(urlOrPath),
      { headers: { Authorization: `Bearer ${apiKey()}` } },
      TRANSFER_TIMEOUT_MS,
    );
    if (!response.ok) throw await failure(response);
    return response;
  };

  /** Authenticated multipart/form-data POST (fetch sets the boundary). */
  const postForm = async (path: string, form: FormData): Promise<JsonObject> =>
    json(path, { method: "POST", body: form, timeoutMs: TRANSFER_TIMEOUT_MS });

  return {
    /** Getter, so nothing resolves the config until a command actually needs the host. */
    get baseUrl() {
      return resolvedBaseUrl();
    },
    apiKey,
    absolute,
    json,
    publicJson,
    download,
    postForm,
  };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Build a Blob for a local file without pulling in a dependency. Bun.file streams
 * the file; the node fallback reads it into memory. The content type is derived
 * from the extension so multipart parts are typed even on the fallback path.
 */
export function fileBlob(path: string): { blob: Blob; name: string; size: number } {
  let size = 0;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new CliError(`Not a file: ${path}`);
    size = stats.size;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read file: ${path}`, { exitCode: 1, code: "file_not_found" });
  }

  const name = basename(path);
  const type = MIME_BY_EXTENSION[extname(name).toLowerCase()];
  if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
    return { blob: type ? Bun.file(path, { type }) : Bun.file(path), name, size };
  }
  return { blob: new Blob([readFileSync(path)], type ? { type } : undefined), name, size };
}
