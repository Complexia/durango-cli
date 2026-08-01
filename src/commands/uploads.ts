import { optionNumber, optionString } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { usageError } from "../lib/errors.js";
import { formatBytes } from "../lib/files.js";
import { fileBlob, type JsonObject } from "../lib/http.js";

const UPLOADS_PATH = "/api/v1/videos/uploads";

/** POST /api/v1/videos/uploads as multipart/form-data. */
export async function uploadLocalFile(ctx: Ctx, path: string, name?: string): Promise<JsonObject> {
  const file = fileBlob(path);
  const form = new FormData();
  // The multipart filename must stay the real file name: the server derives the
  // content type from it. A display name travels in its own `name` field.
  form.append("file", file.blob, file.name);
  if (name) form.append("name", name);

  ctx.out.note(`Uploading ${file.name} (${formatBytes(file.size)})...`);
  const upload = await ctx.http.postForm(UPLOADS_PATH, form);
  ctx.out.note(`Uploaded ${file.name} -> ${String(upload.id ?? "")}`);
  return upload;
}

/** POST /api/v1/videos/uploads with a JSON body for server-side URL ingest. */
export async function uploadFromUrl(ctx: Ctx, url: string, name?: string): Promise<JsonObject> {
  const body: JsonObject = { url };
  if (name) body.name = name;

  ctx.out.note(`Ingesting ${url}...`);
  const upload = await ctx.http.json(UPLOADS_PATH, {
    method: "POST",
    body: JSON.stringify(body),
  });
  ctx.out.note(`Uploaded -> ${String(upload.id ?? "")}`);
  return upload;
}

export async function commandVideoUpload(ctx: Ctx) {
  const file = ctx.positionals[2];
  const url = optionString(ctx.options, "url");
  const name = optionString(ctx.options, "name");

  if (!file && !url) {
    throw usageError("Usage: durango video upload <file> | durango video upload --url <url> [--name <name>]");
  }
  if (file && url) {
    throw usageError("Pass either a local file or --url, not both.");
  }

  const upload = url ? await uploadFromUrl(ctx, url, name) : await uploadLocalFile(ctx, file!, name);
  ctx.out.data(upload);
}

export async function commandUploads(ctx: Ctx) {
  const action = ctx.positionals[1];

  if (action === "list") {
    const limit = optionNumber(ctx.options, "limit", 50);
    ctx.out.data(await ctx.http.json(`${UPLOADS_PATH}?limit=${encodeURIComponent(String(limit))}`));
    return;
  }

  if (action === "get") {
    const id = ctx.positionals[2];
    if (!id) throw usageError("Usage: durango uploads get <id>");
    ctx.out.data(await ctx.http.json(`${UPLOADS_PATH}/${encodeURIComponent(id)}`));
    return;
  }

  if (action === "delete") {
    const id = ctx.positionals[2];
    if (!id) throw usageError("Usage: durango uploads delete <id>");
    ctx.out.data(await ctx.http.json(`${UPLOADS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }));
    return;
  }

  throw usageError("Usage: durango uploads list [--limit N] | durango uploads get <id> | durango uploads delete <id>");
}
