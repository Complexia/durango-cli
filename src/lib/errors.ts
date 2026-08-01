export type CliErrorOptions = {
  /** Process exit code: 1 for usage/client errors, 2 for server/transport errors. */
  exitCode?: number;
  /** Machine readable error code surfaced in `--json` mode. */
  code?: string;
  /** Extra fields merged into the `--json` error object (e.g. `uploaded_ids`). */
  details?: Record<string, unknown>;
};

/** An error that is reported to the user without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: CliErrorOptions | number = {}) {
    super(message);
    const resolved = typeof options === "number" ? { exitCode: options } : options;
    this.name = "CliError";
    this.exitCode = resolved.exitCode ?? 1;
    this.code = resolved.code ?? (this.exitCode >= 2 ? "server_error" : "usage_error");
    this.details = resolved.details;
  }

  /** Copy carrying extra machine-readable context (work already done before the failure). */
  withDetails(details: Record<string, unknown>): CliError {
    return new CliError(this.message, {
      exitCode: this.exitCode,
      code: this.code,
      details: { ...this.details, ...details },
    });
  }
}

/** Usage errors always exit 1 and carry the `usage_error` code. */
export function usageError(message: string) {
  return new CliError(message, { exitCode: 1, code: "usage_error" });
}

/**
 * A 2xx response the CLI could not make sense of (unparseable body, missing id).
 * Exit 2 so agents treat it as a server-side problem worth retrying, not a bad command.
 */
export function invalidResponse(message: string) {
  return new CliError(message, { exitCode: 2, code: "invalid_response" });
}

/**
 * Transport-level failure codes: the request never reached the API (or died on the
 * wire), so nothing about the command itself is wrong. Node/undici use errno-style
 * codes; Bun's fetch reports its own names for the same conditions.
 */
const CONNECTION_ERROR_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EPROTO",
  "ETIMEDOUT",
  "EAI_NONAME",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // Bun
  "ConnectionClosed",
  "ConnectionRefused",
  "DNSException",
  "FailedToOpenSocket",
]);

/** Bun and undici both surface bare failures with no machine-readable code. */
const CONNECTION_ERROR_MESSAGES =
  /^fetch failed$|unable to connect|failed to fetch|socket hang up|network error|getaddrinfo|connection (refused|closed|reset)/i;

/** The error plus everything reachable through `cause` / AggregateError `errors`. */
function errorChain(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const node = value as { cause?: unknown; errors?: unknown };
  const nested = Array.isArray(node.errors)
    ? node.errors.flatMap((entry) => errorChain(entry, seen))
    : [];
  return [value, ...errorChain(node.cause, seen), ...nested];
}

/**
 * Classify a thrown value as a connection-level failure, or `undefined` if it is
 * something else. Exit 2 on purpose: AGENTS.md tells agents that exit 1 is their
 * own fault and must not be retried, and an unreachable host is neither.
 */
export function connectionError(value: unknown): CliError | undefined {
  for (const node of errorChain(value)) {
    const code = (node as { code?: unknown }).code;
    if (typeof code !== "string" || !CONNECTION_ERROR_CODES.has(code)) continue;
    const message = node instanceof Error && node.message ? node.message : code;
    return new CliError(`Could not reach the server (${code}): ${message}`, {
      exitCode: 2,
      code: "connection_error",
    });
  }

  const message = value instanceof Error ? value.message : "";
  if (message && CONNECTION_ERROR_MESSAGES.test(message)) {
    return new CliError(`Could not reach the server: ${message}`, {
      exitCode: 2,
      code: "connection_error",
    });
  }

  return undefined;
}
