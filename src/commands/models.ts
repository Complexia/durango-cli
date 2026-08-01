import { optionString } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { usageError } from "../lib/errors.js";

export async function commandModels(ctx: Ctx) {
  if (ctx.positionals[1] !== "list") {
    throw usageError("Usage: durango models list [--type chat|image|video]");
  }
  const type = optionString(ctx.options, "type");
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  ctx.out.data(await ctx.http.json(`/api/v1/models${query}`));
}
