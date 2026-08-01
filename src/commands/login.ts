import { spawn } from "node:child_process";
import { arch, hostname, platform, release } from "node:os";

import { optionString } from "../lib/args.js";
import { CONFIG_PATH, normalizeBaseUrl, readConfig, writeConfig } from "../lib/config.js";
import type { Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { CLI_VERSION } from "../lib/help.js";
import type { JsonObject } from "../lib/http.js";

/**
 * Best-effort browser launch. A missing opener (no `open`/`xdg-open` on PATH,
 * headless container, stripped environment) is never fatal: the caller already
 * has the code and URL, so we only report it. The spawn `error` event MUST be
 * handled — it fires asynchronously outside any promise chain and would
 * otherwise crash the process with a raw stack trace.
 */
function openBrowser(url: string, onFailure: (reason: string) => void) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const commandArgs = process.platform === "win32"
    ? ["/c", "start", "", url]
    : [url];

  try {
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error: Error) => onFailure(error.message));
    child.unref();
  } catch (error) {
    onFailure(error instanceof Error ? error.message : String(error));
  }
}

export async function commandLogin(ctx: Ctx) {
  const baseUrl = optionString(ctx.options, "base-url");
  if (baseUrl) {
    const config = readConfig();
    config.baseUrl = normalizeBaseUrl(baseUrl);
    writeConfig(config);
  }

  const started = await ctx.http.publicJson("/api/cli/auth/start", {
    method: "POST",
    body: JSON.stringify({
      hostname: hostname(),
      machine_name: hostname(),
      platform: platform(),
      arch: arch(),
      os_version: release(),
      cli_version: CLI_VERSION,
    }),
  });

  const authorizeUrl = String(started.authorize_url || "");
  const attemptId = String(started.attempt_id || "");
  const pollToken = String(started.poll_token || "");
  const code = String(started.code || "");
  const intervalSeconds = Number(started.interval || 2);
  const expiresAt = Number(started.expires_at || Date.now() + 10 * 60 * 1000);

  if (!authorizeUrl || !attemptId || !pollToken) {
    throw new CliError("Durango did not return a valid login attempt.", { exitCode: 2, code: "login_failed" });
  }

  // The code and URL are the only way a human can finish this flow, so they are
  // printed in --json mode too — on stderr, which is outside the JSON contract.
  const announce = (text: string) => (ctx.out.isJson ? ctx.out.tell(text) : ctx.out.say(text));

  announce("Opening browser for Durango login...\n");
  announce(`Verification code: ${code}`);
  announce(`Login URL: ${authorizeUrl}\n`);
  openBrowser(authorizeUrl, (reason) => {
    ctx.out.tell(`Could not open a browser automatically (${reason}). Open the login URL above manually.`);
  });
  announce("Waiting for authorization...");

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    const status = await ctx.http.publicJson("/api/cli/auth/status", {
      method: "POST",
      body: JSON.stringify({ attempt_id: attemptId, poll_token: pollToken }),
    });

    if (status.status === "authorized") {
      const completed = await ctx.http.publicJson("/api/cli/auth/complete", {
        method: "POST",
        body: JSON.stringify({ attempt_id: attemptId, poll_token: pollToken }),
      });
      const apiKey = String(completed.api_key || "");
      if (!apiKey) {
        throw new CliError("Durango did not return an API key.", { exitCode: 2, code: "login_failed" });
      }
      const config = readConfig();
      config.apiKey = apiKey;
      if (baseUrl) config.baseUrl = normalizeBaseUrl(baseUrl);
      writeConfig(config);

      const user = completed.user && typeof completed.user === "object" ? (completed.user as JsonObject) : {};
      if (ctx.out.isJson) {
        ctx.out.data({
          object: "login",
          authenticated: true,
          config_path: CONFIG_PATH,
          base_url: ctx.http.baseUrl,
          user,
        });
        return;
      }
      const label = typeof user.email === "string" && user.email ? ` as ${user.email}` : "";
      ctx.out.say(`Signed in${label}. Saved credentials to ${CONFIG_PATH}`);
      return;
    }

    if (status.status === "completed") {
      throw new CliError("This login attempt was already completed. Run durango login again.", {
        exitCode: 1,
        code: "login_already_completed",
      });
    }

    if (status.status === "expired" || status.status === "cancelled") {
      throw new CliError("Durango login expired. Run durango login again.", { exitCode: 1, code: "login_expired" });
    }
  }

  throw new CliError("Durango login timed out. Run durango login again.", { exitCode: 1, code: "login_timeout" });
}
