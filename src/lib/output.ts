import { CliError, connectionError } from "./errors.js";

export type OutputMode = "human" | "json";

export type ErrorPayload = {
  error: {
    message: string;
    code: string;
    [key: string]: unknown;
  };
};

/** Normalize anything thrown into a CliError. */
export function toCliError(value: unknown): CliError {
  if (value instanceof CliError) return value;
  // A refused connection or a dead DNS name is not the caller's mistake; it must not
  // land in the exit-1 "fix your command, do not retry" bucket.
  const connection = connectionError(value);
  if (connection) return connection;
  if (value instanceof Error) {
    return new CliError(value.message || String(value), { exitCode: 1, code: "internal_error" });
  }
  return new CliError(String(value), { exitCode: 1, code: "internal_error" });
}

/** The `--json` error envelope defined by the contract, plus any error details. */
export function errorPayload(value: unknown): ErrorPayload {
  const error = toCliError(value);
  return { error: { message: error.message, code: error.code, ...error.details } };
}

export function formatJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Output router. In `--json` mode exactly one JSON object reaches stdout and all
 * human chatter is suppressed; in human mode status lines go to stderr so stdout
 * stays pipeable. `tell()` is the escape hatch for information the caller cannot
 * work without (login code/URL): stderr is never part of the JSON contract.
 */
export class Output {
  private emitted = false;

  constructor(readonly mode: OutputMode = "human") {}

  get isJson() {
    return this.mode === "json";
  }

  /** True once the single stdout JSON object has been written. */
  get hasEmitted() {
    return this.emitted;
  }

  /** The single machine-readable result object. Later calls are ignored. */
  data(value: unknown) {
    if (this.emitted) return;
    this.emitted = true;
    process.stdout.write(formatJson(value));
  }

  /** Human-only line on stdout. */
  say(text: string) {
    if (this.isJson) return;
    process.stdout.write(`${text}\n`);
  }

  /** Human-only status/progress line on stderr. */
  note(text: string) {
    if (this.isJson) return;
    process.stderr.write(`${text}\n`);
  }

  /** Always-on stderr line, including in `--json` mode. Never touches stdout. */
  tell(text: string) {
    process.stderr.write(`${text}\n`);
  }
}
