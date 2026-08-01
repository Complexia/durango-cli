import { optionString, requireOption } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { usageError } from "../lib/errors.js";
import { downloadTo } from "../lib/files.js";

export async function commandDownload(ctx: Ctx) {
  const target = ctx.positionals[1];
  if (!target) {
    throw usageError("Usage: durango download <url-or-id> --type image|video --out <path>");
  }

  const outputPath = requireOption(ctx.options, "out");
  const type = optionString(ctx.options, "type");
  const path = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("/api/")
    ? target
    : type === "image"
      ? `/api/v1/images/${target}`
      : type === "video"
        ? `/api/v1/videos/${target}`
        : target;

  const written = await downloadTo(ctx.http, path, outputPath);

  if (ctx.out.isJson) {
    ctx.out.data({ object: "download", source: path, ...written });
    return;
  }
  ctx.out.note(`Wrote ${written.path}`);
}
