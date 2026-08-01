import { optionString } from "../lib/args.js";
import { CONFIG_PATH, normalizeBaseUrl, readConfig, writeConfig } from "../lib/config.js";
import type { Ctx } from "../lib/context.js";
import { usageError } from "../lib/errors.js";

export async function commandConfig(ctx: Ctx) {
  const action = ctx.positionals[1];
  if (action !== "set") {
    throw usageError("Usage: durango config set [--api-key dgo_...] [--base-url https://durango.sh]");
  }

  const config = readConfig();
  const apiKey = optionString(ctx.options, "api-key");
  const baseUrl = optionString(ctx.options, "base-url");
  if (!apiKey && !baseUrl) {
    throw usageError("Pass --api-key, --base-url, or both.");
  }
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseUrl = normalizeBaseUrl(baseUrl);
  writeConfig(config);

  if (ctx.out.isJson) {
    ctx.out.data({
      object: "config",
      config_path: CONFIG_PATH,
      base_url: config.baseUrl ?? null,
      api_key_set: Boolean(config.apiKey),
    });
    return;
  }
  ctx.out.say(`Saved ${CONFIG_PATH}`);
}
