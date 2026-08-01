import { readFileSync } from "node:fs";

import {
  optionBoolean,
  optionChoice,
  optionNumber,
  optionString,
  optionStrings,
  optionalNumber,
  requireOption,
} from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { CliError, invalidResponse, usageError } from "../lib/errors.js";
import { downloadGeneratedAsset, withoutInlineData } from "../lib/files.js";
import type { JsonObject } from "../lib/http.js";
import { toCliError } from "../lib/output.js";
import { pollJob } from "../lib/poll.js";
import { commandVideoUpload, uploadLocalFile } from "./uploads.js";

const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "original"] as const;
const RESOLUTIONS = ["720p", "1080p", "original"] as const;

function jobError(payload: JsonObject, fallback: string) {
  const error = payload.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as JsonObject).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

/** `--operations` accepts inline JSON or `@path/to/plan.json`. */
function parseOperations(raw: string | undefined): unknown[] | undefined {
  if (!raw) return undefined;
  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw usageError(`--operations file not found or unreadable: ${path}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError("--operations must be valid JSON (an array of operations, or @file.json).");
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as JsonObject).operations)) {
    return (parsed as JsonObject).operations as unknown[];
  }
  throw usageError("--operations must be a JSON array or an object with an \"operations\" array.");
}

async function finishJob(
  ctx: Ctx,
  final: JsonObject,
  outputPath: string | undefined,
  fallbackExtension: string,
) {
  if (!outputPath) {
    ctx.out.data(final);
    return;
  }
  const written = await downloadGeneratedAsset(ctx.http, final, outputPath, fallbackExtension);
  if (ctx.out.isJson) {
    // The bytes are on disk; echoing the base64 payload back would only bloat stdout.
    ctx.out.data({ ...withoutInlineData(final), output_path: written.path });
    return;
  }
  ctx.out.note(`Wrote ${written.path}`);
}

async function commandVideoGenerate(ctx: Ctx) {
  const body: JsonObject = {
    model: requireOption(ctx.options, "model"),
    prompt: requireOption(ctx.options, "prompt"),
    aspect_ratio: optionString(ctx.options, "aspect-ratio") || "16:9",
    resolution: optionString(ctx.options, "resolution") || "720p",
    duration: optionNumber(ctx.options, "duration", 5),
    source_images: optionStrings(ctx.options, "source-image"),
    source_image_ids: optionStrings(ctx.options, "source-image-id"),
    private: optionBoolean(ctx.options, "private"),
  };
  const modelIds = optionStrings(ctx.options, "model-id");
  if (modelIds.length > 0) body.model_ids = modelIds;
  if (ctx.options.audio !== undefined) body.generate_audio = optionBoolean(ctx.options, "audio");

  const started = await ctx.http.json("/api/v1/videos/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!optionBoolean(ctx.options, "wait", true)) {
    ctx.out.data(started);
    return;
  }

  const runId = String(started.id || "");
  if (!runId) throw invalidResponse("Video generation did not return a run id.");

  const path = runId.startsWith("http://") || runId.startsWith("https://")
    ? new URL(runId).pathname
    : `/api/v1/videos/generations/${runId}`;

  const final = await pollJob(ctx, path, {
    intervalMs: optionNumber(ctx.options, "poll-interval", 12) * 1000,
    timeoutMs: optionNumber(ctx.options, "timeout", 30) * 60 * 1000,
    label: "Video status",
    timeoutMessage: "Timed out waiting for video generation.",
  });

  if (final.status !== "completed") {
    throw new CliError(jobError(final, "Video generation failed."), { exitCode: 1, code: "generation_failed" });
  }

  await finishJob(ctx, final, optionString(ctx.options, "out"), "mp4");
}

async function commandVideoEdit(ctx: Ctx) {
  const sources = [...optionStrings(ctx.options, "source")];
  const sourceFiles = optionStrings(ctx.options, "source-file");
  const prompt = optionString(ctx.options, "prompt");
  const operations = parseOperations(optionString(ctx.options, "operations"));

  if (sources.length === 0 && sourceFiles.length === 0) {
    throw usageError("Pass at least one --source <id> or --source-file <path>.");
  }
  if (!prompt && !operations) {
    throw usageError("Pass --prompt \"...\" (or --operations '[...]' for an explicit edit plan).");
  }

  // Uploads are billed, slow work. If anything downstream fails, the ids ride along
  // on the error so the caller can retry the edit without re-uploading.
  const uploadedIds: string[] = [];
  try {
    await runEdit(ctx, sources, sourceFiles, uploadedIds, prompt, operations);
  } catch (error) {
    if (uploadedIds.length === 0) throw error;
    throw toCliError(error).withDetails({ uploaded_ids: uploadedIds });
  }
}

async function runEdit(
  ctx: Ctx,
  sources: string[],
  sourceFiles: string[],
  uploadedIds: string[],
  prompt: string | undefined,
  operations: unknown[] | undefined,
) {
  for (const path of sourceFiles) {
    const upload = await uploadLocalFile(ctx, path, undefined);
    const id = String(upload.id || "");
    if (!id) throw invalidResponse(`Upload of ${path} did not return an id.`);
    uploadedIds.push(id);
    sources.push(id);
  }

  const output: JsonObject = {
    aspect_ratio: optionChoice(ctx.options, "aspect-ratio", ASPECT_RATIOS, "original"),
    resolution: optionChoice(ctx.options, "resolution", RESOLUTIONS, "original"),
    format: "mp4",
  };
  const maxDuration = optionalNumber(ctx.options, "max-duration");
  if (maxDuration !== undefined) output.max_duration = maxDuration;

  const body: JsonObject = { source_video_ids: sources, output };
  if (prompt) body.prompt = prompt;
  if (operations) body.operations = operations;
  const model = optionString(ctx.options, "model");
  if (model) body.model = model;
  const webhook = optionString(ctx.options, "webhook-url");
  if (webhook) body.webhook_url = webhook;

  const started = await ctx.http.json("/api/v1/videos/edits", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!optionBoolean(ctx.options, "wait", true)) {
    ctx.out.data(started);
    return;
  }

  const editId = String(started.id || "");
  if (!editId) throw invalidResponse("Video edit did not return a job id.");
  ctx.out.note(`Edit job ${editId} queued.`);

  const final = await pollJob(ctx, `/api/v1/videos/edits/${encodeURIComponent(editId)}`, {
    intervalMs: optionNumber(ctx.options, "poll-interval", 5) * 1000,
    timeoutMs: optionNumber(ctx.options, "timeout", 30) * 60 * 1000,
    label: "Edit status",
    timeoutMessage: "Timed out waiting for the video edit.",
  });

  if (final.status !== "completed") {
    throw new CliError(jobError(final, "Video edit failed."), { exitCode: 1, code: "edit_failed" });
  }

  await finishJob(ctx, final, optionString(ctx.options, "out"), "mp4");
}

async function commandVideoEdits(ctx: Ctx) {
  const action = ctx.positionals[2];

  if (action === "status") {
    const id = ctx.positionals[3];
    if (!id) throw usageError("Usage: durango video edits status <id>");
    ctx.out.data(await ctx.http.json(`/api/v1/videos/edits/${encodeURIComponent(id)}`));
    return;
  }

  if (action === "list") {
    const limit = optionNumber(ctx.options, "limit", 20);
    ctx.out.data(await ctx.http.json(`/api/v1/videos/edits?limit=${encodeURIComponent(String(limit))}`));
    return;
  }

  throw usageError("Usage: durango video edits status <id> | durango video edits list [--limit N]");
}

export async function commandVideo(ctx: Ctx) {
  const action = ctx.positionals[1];

  if (action === "status") {
    const runId = ctx.positionals[2];
    if (!runId) throw usageError("Usage: durango video status <runId>");
    ctx.out.data(await ctx.http.json(`/api/v1/videos/generations/${encodeURIComponent(runId)}`));
    return;
  }

  if (action === "list") {
    const limit = optionNumber(ctx.options, "limit", 20);
    ctx.out.data(await ctx.http.json(`/api/v1/videos?limit=${encodeURIComponent(String(limit))}`));
    return;
  }

  if (action === "upload") return await commandVideoUpload(ctx);
  if (action === "edits") return await commandVideoEdits(ctx);
  if (action === "edit") return await commandVideoEdit(ctx);
  if (action === "generate") return await commandVideoGenerate(ctx);

  throw usageError(
    "Usage: durango video generate|status <runId>|list|upload|edit|edits status <id>|edits list. Run: durango help video",
  );
}
