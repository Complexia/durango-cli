import type { Ctx } from "./context.js";
import { CliError } from "./errors.js";
import { jsonTimeoutMs, type JsonObject } from "./http.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

export function isTerminal(status: unknown) {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

/** Concise human progress line, e.g. `Edit status: rendering (45%)`. */
export function statusLine(label: string, payload: JsonObject) {
  const status = String(payload.status || "running");
  const progress = payload.progress;
  let suffix = "";
  if (typeof progress === "number" && Number.isFinite(progress) && progress > 0) {
    const percent = progress <= 1 ? progress * 100 : progress;
    suffix = ` (${Math.round(percent)}%)`;
  }
  return `${label}: ${status}${suffix}`;
}

export type PollOptions = {
  intervalMs: number;
  timeoutMs: number;
  label: string;
  timeoutMessage: string;
};

/**
 * Poll a job endpoint until it reaches a terminal status. Human mode prints one
 * status line per poll on stderr; --json mode stays silent. Each request is
 * capped by the smaller of the HTTP timeout and what is left of --timeout, so a
 * hung server cannot outlive the overall budget.
 */
export async function pollJob(ctx: Ctx, path: string, options: PollOptions): Promise<JsonObject> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const payload = await ctx.http.json(path, {
      timeoutMs: Math.max(1_000, Math.min(jsonTimeoutMs(), remaining)),
    });
    if (isTerminal(payload.status)) return payload;
    ctx.out.note(statusLine(options.label, payload));

    const sleepMs = Math.min(options.intervalMs, deadline - Date.now());
    if (sleepMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  throw new CliError(options.timeoutMessage, { exitCode: 1, code: "timeout" });
}
