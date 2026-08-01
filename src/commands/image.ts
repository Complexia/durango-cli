import { optionBoolean, optionString, optionStrings, requireOption } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { usageError } from "../lib/errors.js";
import { downloadGeneratedAsset, withoutInlineData } from "../lib/files.js";

export async function commandImage(ctx: Ctx) {
  if (ctx.positionals[1] !== "generate") {
    throw usageError("Usage: durango image generate --model <id> --prompt <text> [--out image.png]");
  }

  const outputPath = optionString(ctx.options, "out");
  const responseFormat = outputPath
    ? "b64_json"
    : optionString(ctx.options, "response-format") || "url";

  const body = {
    model: requireOption(ctx.options, "model"),
    prompt: requireOption(ctx.options, "prompt"),
    aspect_ratio: optionString(ctx.options, "aspect-ratio") || "1:1",
    image_size: optionString(ctx.options, "image-size") || "1K",
    response_format: responseFormat,
    source_images: optionStrings(ctx.options, "source-image"),
    private: optionBoolean(ctx.options, "private"),
  };

  const result = await ctx.http.json("/api/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (outputPath) {
    const written = await downloadGeneratedAsset(ctx.http, result, outputPath, "png");
    if (ctx.out.isJson) {
      // The image is on disk; don't echo the base64 payload back on stdout too.
      ctx.out.data({ ...withoutInlineData(result), output_path: written.path });
      return;
    }
    ctx.out.note(`Wrote ${written.path}`);
    return;
  }

  ctx.out.data(result);
}
