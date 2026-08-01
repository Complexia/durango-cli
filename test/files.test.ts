/**
 * Download-to-disk behaviour: the failure paths in particular. Every one of these
 * must end as a CliError with the partial file cleaned up — never an uncaught
 * stream event, and never a short file left where a complete one is expected.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/lib/errors.js";
import { writeResponseToFile } from "../src/lib/files.js";

const WORK_DIR = mkdtempSync(join(tmpdir(), "durango-files-test-"));

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "video/mp4", ...headers } });
}

async function failureOf(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected the write to fail");
}

describe("writeResponseToFile", () => {
  test("writes a complete body and leaves no staging file behind", async () => {
    const out = join(WORK_DIR, "complete.mp4");
    const payload = new Uint8Array(4096).fill(9);
    const written = await writeResponseToFile(
      streamed([payload], { "content-length": String(payload.byteLength) }),
      out,
    );

    expect(written).toEqual({ path: out, bytes: payload.byteLength, content_type: "video/mp4" });
    expect(statSync(out).size).toBe(payload.byteLength);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  test("a body shorter than Content-Length fails and removes the partial file", async () => {
    const out = join(WORK_DIR, "truncated.mp4");
    const error = await failureOf(
      writeResponseToFile(streamed([new Uint8Array(100)], { "content-length": "1000" }), out),
    );

    expect(error.code).toBe("truncated_download");
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("expected 1000 bytes but received 100");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  test("a body longer than Content-Length is a mismatch too", async () => {
    const out = join(WORK_DIR, "overlong.mp4");
    const error = await failureOf(
      writeResponseToFile(streamed([new Uint8Array(500)], { "content-length": "100" }), out),
    );
    expect(error.code).toBe("truncated_download");
    expect(existsSync(out)).toBe(false);
  });

  test("no Content-Length means nothing to compare against", async () => {
    const out = join(WORK_DIR, "unknown-length.mp4");
    const written = await writeResponseToFile(streamed([new Uint8Array(64)]), out);
    expect(written.bytes).toBe(64);
    expect(statSync(out).size).toBe(64);
  });

  test("a compressed body is exempt: the header counts encoded bytes", async () => {
    const out = join(WORK_DIR, "compressed.mp4");
    const written = await writeResponseToFile(
      streamed([new Uint8Array(300)], { "content-length": "120", "content-encoding": "gzip" }),
      out,
    );
    expect(written.bytes).toBe(300);
  });

  test("an unwritable destination surfaces as a CliError, not an uncaught stream event", async () => {
    const out = join(WORK_DIR, "no-such-dir", "clip.mp4");
    const error = await failureOf(writeResponseToFile(streamed([new Uint8Array(1024)]), out));
    expect(error.code).toBe("write_error");
    expect(error.exitCode).toBe(1);
    // The message leads with the path the caller asked for, not the staging file.
    expect(error.message.startsWith(`Could not write ${out}:`)).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  test(
    "a sink that dies mid-transfer (FIFO reader exits) becomes a CliError",
    async () => {
      if (process.platform === "win32") return;
      const fifo = join(WORK_DIR, "pipe.mp4");
      const made = Bun.spawnSync(["mkfifo", fifo]);
      if (!made.success) return;

      // The reader takes one byte and leaves; every later write gets EPIPE while the
      // loop is parked on reader.read() — the exact shape that used to crash the CLI.
      Bun.spawn(["sh", "-c", `head -c 1 ${JSON.stringify(fifo)} > /dev/null`], {
        stdout: "ignore",
        stderr: "ignore",
      });

      const chunks = Array.from({ length: 64 }, () => new Uint8Array(1024 * 1024));
      const error = await failureOf(writeResponseToFile(streamed(chunks), fifo));
      expect(error.code).toBe("write_error");
      expect(error.message).toContain(fifo);
    },
    15_000,
  );
});
