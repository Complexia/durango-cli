import { describe, expect, test } from "bun:test";

import { CliError, invalidResponse, usageError } from "../src/lib/errors.js";
import { withoutInlineData } from "../src/lib/files.js";
import { errorPayload, formatJson, toCliError } from "../src/lib/output.js";
import { statusLine } from "../src/lib/poll.js";

describe("error payloads", () => {
  test("usage errors serialize to the contract envelope", () => {
    const payload = errorPayload(usageError("Missing --prompt."));
    expect(payload).toEqual({ error: { message: "Missing --prompt.", code: "usage_error" } });
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(Object.keys(payload.error).sort()).toEqual(["code", "message"]);
  });

  test("server errors keep their code and exit 2", () => {
    const error = new CliError("Upstream provider failed.", { exitCode: 2, code: "provider_error" });
    expect(error.exitCode).toBe(2);
    expect(errorPayload(error)).toEqual({
      error: { message: "Upstream provider failed.", code: "provider_error" },
    });
  });

  test("exit code 2 defaults to the server_error code", () => {
    expect(new CliError("boom", { exitCode: 2 }).code).toBe("server_error");
    expect(new CliError("boom").code).toBe("usage_error");
    expect(new CliError("boom").exitCode).toBe(1);
  });

  test("legacy numeric exit-code argument still works", () => {
    const error = new CliError("boom", 2);
    expect(error.exitCode).toBe(2);
  });

  test("unknown throwables become internal errors that still exit nonzero", () => {
    const fromString = toCliError("something went sideways");
    expect(fromString.code).toBe("internal_error");
    expect(fromString.exitCode).toBe(1);
    expect(errorPayload(new TypeError("x.map is not a function"))).toEqual({
      error: { message: "x.map is not a function", code: "internal_error" },
    });
  });

  test("the JSON error envelope is exactly one parseable object", () => {
    const text = formatJson(errorPayload(usageError("Pass at least one --source <id>.")));
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n}").length).toBe(2);
    expect(JSON.parse(text)).toEqual({
      error: { message: "Pass at least one --source <id>.", code: "usage_error" },
    });
  });
});

describe("connection failures", () => {
  const withCode = (code: string, message = "boom") => Object.assign(new Error(message), { code });

  test("errno-style transport codes are retryable exit-2 connection errors", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH"]) {
      const error = toCliError(withCode(code));
      expect(error.code).toBe("connection_error");
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(code);
    }
  });

  test("codes nested under cause (undici) and errors[] (happy eyeballs) are found", () => {
    const undici = Object.assign(new TypeError("fetch failed"), { cause: withCode("ECONNREFUSED") });
    expect(toCliError(undici).code).toBe("connection_error");

    const aggregate = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new AggregateError([withCode("ENOTFOUND")], "all attempts failed"), {}),
    });
    expect(toCliError(aggregate).code).toBe("connection_error");
  });

  test("Bun's own failure names are classified too", () => {
    expect(toCliError(withCode("ConnectionRefused", "Unable to connect.")).code).toBe("connection_error");
    expect(toCliError(new Error("Unable to connect. Is the computer able to access the url?")).code)
      .toBe("connection_error");
  });

  test("a self-referencing cause chain terminates", () => {
    const looping = new Error("nope") as Error & { cause?: unknown };
    looping.cause = looping;
    expect(toCliError(looping).code).toBe("internal_error");
  });
});

describe("invalid responses", () => {
  test("unparseable 2xx bodies are retryable server errors, not usage errors", () => {
    const error = invalidResponse("Durango returned a 200 response that is not valid JSON.");
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe("invalid_response");
  });
});

describe("error details", () => {
  test("work already done rides along on the error payload", () => {
    const error = new CliError("planner unavailable", { exitCode: 2, code: "planner_down" });
    expect(errorPayload(error.withDetails({ uploaded_ids: ["up_1"] }))).toEqual({
      error: { message: "planner unavailable", code: "planner_down", uploaded_ids: ["up_1"] },
    });
  });

  test("details never displace message or code", () => {
    const payload = errorPayload(usageError("nope").withDetails({ uploaded_ids: [] }));
    expect(payload.error.message).toBe("nope");
    expect(payload.error.code).toBe("usage_error");
  });
});

describe("inline data stripping", () => {
  test("drops b64_json once the bytes are on disk", () => {
    const payload = {
      object: "list",
      data: [{ id: "img_1", b64_json: "AAAA", content_type: "image/png" }, { id: "img_2", url: "https://x" }],
    };
    expect(withoutInlineData(payload)).toEqual({
      object: "list",
      data: [{ id: "img_1", content_type: "image/png" }, { id: "img_2", url: "https://x" }],
    });
    expect(payload.data[0].b64_json).toBe("AAAA");
  });

  test("payloads without a data array pass through untouched", () => {
    const payload = { id: "edit_1", status: "completed" };
    expect(withoutInlineData(payload)).toBe(payload);
  });
});

describe("progress lines", () => {
  test("renders status without progress", () => {
    expect(statusLine("Video status", { status: "running" })).toBe("Video status: running");
  });

  test("renders fractional progress as a percentage", () => {
    expect(statusLine("Edit status", { status: "rendering", progress: 0.45 })).toBe("Edit status: rendering (45%)");
  });

  test("accepts progress already expressed as a percentage", () => {
    expect(statusLine("Edit status", { status: "rendering", progress: 60 })).toBe("Edit status: rendering (60%)");
  });

  test("falls back to running for missing status", () => {
    expect(statusLine("Video status", {})).toBe("Video status: running");
  });
});
