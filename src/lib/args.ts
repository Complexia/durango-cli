import { CliError, usageError } from "./errors.js";
import type { FlagSpec } from "./help.js";

export type OptionValue = string | boolean | string[];
export type Options = Record<string, OptionValue>;
export type ParsedArgs = {
  positionals: string[];
  options: Options;
};

/** Flag schema for the command being parsed, keyed by flag name (no leading --). */
export type FlagLookup = ReadonlyMap<string, FlagSpec>;

export type ParseOptions = {
  /**
   * Reject declared flags that are missing a value, values outside a flag's declared
   * `choices`, and values that are not numbers where the schema says they must be.
   * Off for the preliminary parse that only needs --json.
   */
  strict?: boolean;
};

/** End-of-flags marker: everything after it is a positional, whatever it looks like. */
export const END_OF_FLAGS = "--";

function collect(options: Options, key: string, value: OptionValue) {
  const current = options[key];
  if (current === undefined) {
    options[key] = value;
  } else if (Array.isArray(current)) {
    current.push(String(value));
  } else {
    options[key] = [String(current), String(value)];
  }
}

/** Values outside a flag's declared `choices` are a usage error, not a silent pass-through. */
function checkChoices(options: Options, flags: FlagLookup) {
  for (const [key, value] of Object.entries(options)) {
    const choices = flags.get(key)?.choices;
    if (!choices) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== "string") continue;
      if (!choices.includes(entry)) {
        throw usageError(`--${key} must be one of: ${choices.join(", ")}.`);
      }
    }
  }
}

/**
 * Declared number flags are validated here, before the command runs — a bad
 * `--max-duration` must not cost an upload or a paid render first.
 */
function checkNumbers(options: Options, flags: FlagLookup) {
  for (const [key, value] of Object.entries(options)) {
    if (flags.get(key)?.type !== "number") continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== "string") continue;
      if (!entry.trim() || !Number.isFinite(Number(entry))) {
        throw usageError(`--${key} must be a number.`);
      }
    }
  }
}

/** `--flag true` / `--flag=false` style values for a declared boolean. */
function booleanValue(token: string | undefined) {
  if (token === "true") return true;
  if (token === "false") return false;
  return undefined;
}

/**
 * Long-flag parser. Supported forms:
 *   --flag value    --flag=value    --flag (boolean true)    --no-flag (boolean false)
 *   --flag true|false (declared booleans only)               -- (end of flags)
 * Repeating a flag collects the values into an array.
 *
 * When `flags` is supplied, declared booleans only swallow the following token when
 * it is literally `true` or `false`, and declared value flags must be given a value
 * of the declared type (in strict mode).
 */
export function parseArgs(argv: string[], flags?: FlagLookup, options: ParseOptions = {}): ParsedArgs {
  const strict = options.strict === true;
  const positionals: string[] = [];
  const parsed: Options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === END_OF_FLAGS) {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    if (arg.startsWith("--no-")) {
      const key = arg.slice(5);
      const spec = flags?.get(key);
      if (strict && spec && spec.type !== "boolean") {
        throw usageError(`--${key} takes a value, so --no-${key} is not valid.`);
      }
      collect(parsed, key, false);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.trim();
    const spec = flags?.get(key);
    const next = argv[index + 1];
    const nextIsValue = next !== undefined && !next.startsWith("--");

    let value: OptionValue;
    if (spec?.type === "boolean" && inlineValue !== undefined) {
      // --json=false must mean false, not the string "false".
      const explicit = booleanValue(inlineValue);
      if (explicit === undefined && strict) {
        throw usageError(`--${key} must be true or false.`);
      }
      value = explicit ?? inlineValue;
    } else if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (spec?.type === "boolean") {
      // A declared boolean takes an immediate true/false token if one is there, and
      // nothing else: any other following token stays a positional.
      const explicit = booleanValue(next);
      if (explicit === undefined) {
        value = true;
      } else {
        index += 1;
        value = explicit;
      }
    } else if (nextIsValue) {
      index += 1;
      value = next;
    } else if (spec && strict) {
      throw usageError(`--${key} requires a value.`);
    } else {
      value = true;
    }

    collect(parsed, key, value);
  }

  if (strict && flags) {
    checkChoices(parsed, flags);
    checkNumbers(parsed, flags);
  }

  return { positionals, options: parsed };
}

export function optionString(options: Options, key: string): string | undefined {
  const value = options[key];
  if (Array.isArray(value)) return value.at(-1);
  if (typeof value === "string") return value;
  return undefined;
}

export function optionStrings(options: Options, key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

export function optionBoolean(options: Options, key: string, fallback = false): boolean {
  const raw = options[key];
  // Repeated flags collect into an array; the last occurrence wins, mirroring
  // optionString. Without this, `--json --json` would fall through to the
  // schema default and silently invert the user's intent.
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "false" && value !== "0";
  return fallback;
}

export function optionNumber(options: Options, key: string, fallback: number): number {
  const value = optionString(options, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${key} must be a number.`);
  }
  return parsed;
}

export function optionalNumber(options: Options, key: string): number | undefined {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${key} must be a number.`);
  }
  return parsed;
}

export function requireOption(options: Options, key: string): string {
  const value = optionString(options, key);
  if (!value) throw new CliError(`Missing --${key}.`);
  return value;
}

/** Restrict a flag to a known set of values. */
export function optionChoice<T extends string>(
  options: Options,
  key: string,
  choices: readonly T[],
  fallback?: T,
): T | undefined {
  const value = optionString(options, key);
  if (value === undefined) return fallback;
  if (!(choices as readonly string[]).includes(value)) {
    throw new CliError(`--${key} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}
