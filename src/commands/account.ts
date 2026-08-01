import { maskApiKey } from "../lib/config.js";
import type { Ctx } from "../lib/context.js";

export async function commandCredits(ctx: Ctx) {
  ctx.out.data(await ctx.http.json("/api/v1/credits"));
}

export async function commandWhoami(ctx: Ctx) {
  const credits = await ctx.http.json("/api/v1/credits");
  const payload = {
    object: "whoami",
    base_url: ctx.http.baseUrl,
    api_key: maskApiKey(ctx.http.apiKey()),
    tier: credits.tier ?? null,
    balance: credits.balance ?? null,
    limit: credits.limit ?? null,
    period_end: credits.period_end ?? null,
  };

  if (ctx.out.isJson) {
    ctx.out.data(payload);
    return;
  }

  ctx.out.say(`Host:    ${payload.base_url}`);
  ctx.out.say(`API key: ${payload.api_key}`);
  ctx.out.say(`Tier:    ${payload.tier ?? "unknown"}`);
  ctx.out.say(`Credits: ${payload.balance ?? "unknown"}${payload.limit != null ? ` / ${payload.limit}` : ""}`);
  if (payload.period_end) {
    ctx.out.say(`Renews:  ${new Date(Number(payload.period_end)).toISOString()}`);
  }
}
