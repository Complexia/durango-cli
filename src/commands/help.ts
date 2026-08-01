import type { Ctx } from "../lib/context.js";
import { helpSchema, renderHelp } from "../lib/help.js";

export async function commandHelp(ctx: Ctx, filter?: string) {
  if (ctx.out.isJson) {
    ctx.out.data(helpSchema());
    return;
  }
  process.stdout.write(renderHelp(filter ?? ctx.positionals.slice(1).join(" ")));
}
