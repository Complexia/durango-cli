import { once } from "node:events";
import { createWriteStream, renameSync, statSync, unlinkSync, writeFileSync, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";

import { CliError, connectionError } from "./errors.js";
import type { HttpClient, JsonObject } from "./http.js";

export type WrittenFile = {
  path: string;
  bytes: number;
  content_type: string;
};

export function extensionFromContentType(contentType: string, fallback: string) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4")) return "mp4";
  return fallback;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** Write failures that mean the destination itself is wrong — the caller's mistake. */
const BAD_DESTINATION_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

/** A local write failure, reported as a CliError instead of an uncaught stream event. */
function writeError(path: string, error: unknown): CliError {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error && error.message ? error.message : String(error);
  return new CliError(`Could not write ${path}: ${message}`, {
    exitCode: typeof code === "string" && BAD_DESTINATION_CODES.has(code) ? 1 : 2,
    code: "write_error",
  });
}

function removeQuietly(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to clean up, or the directory is gone. Either way the caller is failing already.
  }
}

/**
 * Byte count the peer promised, or `undefined` when there is nothing to check
 * against. The Durango bytes routes always set Content-Length on 200 and 206. A
 * compressed body is skipped: the header then counts encoded bytes, not written ones.
 */
function declaredLength(response: Response): number | undefined {
  const encoding = (response.headers.get("content-encoding") || "").trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** True for a destination that exists and is not a regular file (FIFO, /dev/*, directory). */
function isSpecialFile(path: string) {
  try {
    return !statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A sink failure can land at any moment — including while the read loop is parked
 * on `reader.read()`, where node has nowhere to deliver it and turns it into an
 * uncaught exception (raw stack trace, empty stdout in --json mode). This keeps a
 * listener attached for the whole life of the loop and turns the event into a
 * rejection the loop can be raced against.
 */
function sinkFailure(sink: WriteStream, path: string): Promise<never> {
  const failed = new Promise<never>((_, reject) => {
    sink.on("error", (error: Error) => reject(writeError(path, error)));
  });
  // The read loop usually wins the race; this rejection must never be unhandled.
  failed.catch(() => {});
  return failed;
}

/**
 * Stream a body to disk and return the byte count. Video results run to hundreds of
 * megabytes, so the body is never buffered in memory.
 *
 * The read/write loop is explicit on purpose: `Bun.write(path, response)` never
 * settles as of Bun 1.3.3, and `stream.pipeline(Readable.fromWeb(...))` does not
 * propagate backpressure there either — an 800 MB download peaked near 950 MB RSS.
 * Waiting on `drain` keeps memory flat regardless of how fast the peer sends.
 */
async function streamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
  /** Destination as the caller asked for it: errors name that, not the staging file. */
  label = path,
): Promise<number> {
  const reader = body.getReader();
  const sink = createWriteStream(path);
  const failed = sinkFailure(sink, label);
  let bytes = 0;

  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!sink.write(value)) await once(sink, "drain");
    }
    sink.end();
    await finished(sink);
  };

  try {
    await Promise.race([pump(), failed]);
  } catch (error) {
    sink.destroy();
    await reader.cancel().catch(() => {});
    throw error;
  }

  return bytes;
}

function writeBuffer(path: string, data: Buffer, label = path) {
  try {
    writeFileSync(path, data);
  } catch (error) {
    throw writeError(label, error);
  }
  return data.byteLength;
}

/**
 * Stream a response body to `outputPath`.
 *
 * Bytes land in `<outputPath>.part` and are renamed into place only once the whole
 * body has arrived and matches Content-Length, so a truncated transfer, a write
 * failure, or a crash never leaves a corrupt file at `--out` — there is either a
 * complete file or no file. A destination that already exists as a special file
 * (FIFO, `/dev/stdout`) cannot be staged or unlinked, so it is written through
 * directly and only the length check applies.
 */
export async function writeResponseToFile(response: Response, outputPath: string): Promise<WrittenFile> {
  const contentType = response.headers.get("content-type") || "";
  const expected = declaredLength(response);
  const direct = isSpecialFile(outputPath);
  const writePath = direct ? outputPath : `${outputPath}.part`;

  let bytes = 0;
  try {
    bytes = response.body
      ? await streamToFile(response.body, writePath, outputPath)
      : writeBuffer(writePath, Buffer.from(await response.arrayBuffer()), outputPath);

    if (expected !== undefined && bytes !== expected) {
      throw new CliError(
        `Download ended early: expected ${expected} bytes but received ${bytes} (${outputPath}).`,
        { exitCode: 2, code: "truncated_download" },
      );
    }

    if (!direct) renameSync(writePath, outputPath);
  } catch (error) {
    if (!direct) removeQuietly(writePath);
    if (error instanceof CliError) throw error;
    throw connectionError(error) ?? writeError(outputPath, error);
  }

  return { path: outputPath, bytes, content_type: contentType };
}

export async function downloadTo(http: HttpClient, urlOrPath: string, outputPath: string) {
  return await writeResponseToFile(await http.download(urlOrPath), outputPath);
}

/** First item of an OpenAI-style `{ data: [...] }` payload. */
export function firstResult(payload: unknown): JsonObject {
  const items = payload && typeof payload === "object" ? (payload as JsonObject).data : undefined;
  if (!Array.isArray(items) || items.length === 0) {
    throw new CliError("Response did not include downloadable data.", { exitCode: 2, code: "no_result_data" });
  }
  return items[0] as JsonObject;
}

/**
 * Copy of a result payload with inline base64 blobs removed. Used when the bytes
 * have already been written to `--out` so the emitted JSON stays small.
 */
export function withoutInlineData(payload: JsonObject): JsonObject {
  const items = payload.data;
  if (!Array.isArray(items)) return payload;
  return {
    ...payload,
    data: items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const { b64_json, ...rest } = item as JsonObject;
      return b64_json === undefined ? item : rest;
    }),
  };
}

/**
 * Write the first asset of a generation/edit response, handling both inline
 * base64 payloads and URL references.
 */
export async function downloadGeneratedAsset(
  http: HttpClient,
  payload: unknown,
  outputPath: string,
  fallbackExtension: string,
): Promise<WrittenFile> {
  const first = firstResult(payload);

  if (typeof first.b64_json === "string") {
    const contentType = typeof first.content_type === "string" ? first.content_type : "";
    const extension = extensionFromContentType(contentType, fallbackExtension);
    const finalPath = outputPath.includes(".") ? outputPath : `${outputPath}.${extension}`;
    const data = Buffer.from(first.b64_json, "base64");
    return { path: finalPath, bytes: writeBuffer(finalPath, data), content_type: contentType };
  }

  if (typeof first.url !== "string") {
    throw new CliError("Response did not include a download URL.", { exitCode: 2, code: "no_result_url" });
  }
  return await downloadTo(http, first.url, outputPath);
}
