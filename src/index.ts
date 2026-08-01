#!/usr/bin/env bun

import { commandCredits, commandWhoami } from "./commands/account.js";
import { commandConfig } from "./commands/config.js";
import { commandDownload } from "./commands/download.js";
import { commandHelp } from "./commands/help.js";
import { commandImage } from "./commands/image.js";
import { commandLogin } from "./commands/login.js";
import { commandModels } from "./commands/models.js";
import { commandUploads } from "./commands/uploads.js";
import { commandVideo } from "./commands/video.js";
import { optionBoolean, optionString, parseArgs, type ParsedArgs } from "./lib/args.js";
import type { Ctx } from "./lib/context.js";
import { usageError } from "./lib/errors.js";
import { CLI_VERSION, findCommand, flagTable, type CommandSpec, type FlagSpec } from "./lib/help.js";
import { createHttpClient } from "./lib/http.js";
import { errorPayload, formatJson, Output, toCliError } from "./lib/output.js";

function wantsHelp(args: ParsedArgs) {
  const command = args.positionals[0];
  return (
    !command ||
    command === "help" ||
    command === "-h" ||
    command === "--help" ||
    args.options.help === true ||
    args.options.h === true
  );
}

/**
 * A flag the resolved command does not declare is a usage error, not something to
 * ignore: a typo like `--outt` on `video edit` would otherwise run a paid render and
 * write nothing. Help paths (and an unrecognised command, which only ever reaches
 * help) stay permissive so `durango video edit --help --whatever` still prints help.
 */
function assertKnownFlags(args: ParsedArgs, table: ReadonlyMap<string, FlagSpec>, command: CommandSpec | undefined) {
  if (!command || wantsHelp(args)) return;
  const unknown = Object.keys(args.options).filter((key) => !table.has(key));
  if (unknown.length === 0) return;
  const label = unknown.length === 1 ? "flag" : "flags";
  throw usageError(
    `Unknown ${label} for "${command.name}": ${unknown.map((key) => `--${key}`).join(", ")}. Run: durango help ${command.name}`,
  );
}

async function run(args: ParsedArgs, out: Output) {
  const ctx: Ctx = {
    args,
    positionals: args.positionals,
    options: args.options,
    out,
    http: createHttpClient({
      baseUrl: optionString(args.options, "base-url"),
      apiKey: optionString(args.options, "api-key"),
    }),
  };

  if (args.options.version === true || args.positionals[0] === "version") {
    if (out.isJson) out.data({ object: "cli.version", name: "durango", version: CLI_VERSION });
    else out.say(`durango ${CLI_VERSION}`);
    return;
  }

  const command = args.positionals[0];
  if (wantsHelp(args)) {
    const filter = command === "help" ? args.positionals.slice(1).join(" ") : args.positionals.join(" ");
    return await commandHelp(ctx, filter);
  }

  switch (command) {
    case "config":
      return await commandConfig(ctx);
    case "login":
      return await commandLogin(ctx);
    case "whoami":
      return await commandWhoami(ctx);
    case "credits":
      return await commandCredits(ctx);
    case "models":
      return await commandModels(ctx);
    case "image":
      return await commandImage(ctx);
    case "video":
      return await commandVideo(ctx);
    case "uploads":
      return await commandUploads(ctx);
    case "download":
      return await commandDownload(ctx);
    default:
      throw usageError(`Unknown command: ${command}. Run: durango help`);
  }
}

const argv = process.argv.slice(2);

/**
 * Preliminary lenient parse: enough to know whether --json was requested (and to
 * keep declared booleans from swallowing a positional) before any error can be
 * reported. The strict parse then runs inside the error handler's reach.
 */
const preliminary = parseArgs(argv, flagTable());
const output = new Output(optionBoolean(preliminary.options, "json", false) ? "json" : "human");

async function main() {
  let table = flagTable(preliminary.positionals);
  let parsed = parseArgs(argv, table, { strict: true });

  // The strict pass can recover positionals the lenient pass mis-assigned; if that
  // changed which command we resolved, re-parse against the right flag schema.
  if (findCommand(parsed.positionals)?.name !== findCommand(preliminary.positionals)?.name) {
    table = flagTable(parsed.positionals);
    parsed = parseArgs(argv, table, { strict: true });
  }

  assertKnownFlags(parsed, table, findCommand(parsed.positionals));

  await run(parsed, output);
}

main().catch((error) => {
  const cliError = toCliError(error);
  if (output.isJson && !output.hasEmitted) {
    process.stdout.write(formatJson(errorPayload(cliError)));
  } else {
    process.stderr.write(`durango: ${cliError.message}\n`);
    if (process.env.DURANGO_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
  }
  process.exit(cliError.exitCode);
});
