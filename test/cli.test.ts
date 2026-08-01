/**
 * Process-level tests: the real CLI is spawned as a subprocess against a throwaway
 * local HTTP server, so exit codes, stdout/stderr separation, and the "exactly one
 * JSON object on stdout" rule are checked the way an agent experiences them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
const WORK_DIR = mkdtempSync(join(tmpdir(), "durango-cli-test-"));
const CONFIG_HOME = join(WORK_DIR, "config");

type Run = { code: number; stdout: string; stderr: string };
type Handler = (request: Request, url: URL) => Response | Promise<Response>;

const servers: { stop: (force?: boolean) => void }[] = [];

function mockApi(handler: Handler) {
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request, new URL(request.url)) });
  servers.push(server);
  return server;
}

/**
 * Raw TCP server, for responses `Bun.serve` will not produce: it recomputes
 * Content-Length from the body, so a *lying* Content-Length has to be handwritten.
 */
function rawApi(response: (write: (chunk: string | Uint8Array) => void) => void) {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        response((chunk) => socket.write(chunk));
        socket.flush();
        setTimeout(() => socket.end(), 20);
      },
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { origin: `http://127.0.0.1:${server.port}` };
}

afterAll(() => {
  for (const server of servers) server.stop(true);
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runCli(
  baseUrl: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<Run> {
  // An explicit `undefined` override removes the variable, so a test can run the CLI
  // with no DURANGO_BASE_URL at all and exercise the config-file path.
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: CONFIG_HOME,
    DURANGO_API_KEY: "dgo_test_key",
    DURANGO_BASE_URL: baseUrl,
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) childEnv[key] = value;
  }

  const child = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd: WORK_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

/** Enforces the contract: stdout parses as exactly one JSON object, nothing else. */
function singleJsonObject(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stdout) as unknown;
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  return parsed as Record<string, unknown>;
}

function errorOf(run: Run) {
  return singleJsonObject(run).error as Record<string, unknown>;
}

describe("credits", () => {
  test("happy path exits 0 with one JSON object", async () => {
    const server = mockApi((_request, url) => {
      expect(url.pathname).toBe("/api/v1/credits");
      return json({ object: "credits", balance: 42, tier: "pro" });
    });

    const run = await runCli(server.url.origin, ["credits", "--json"]);
    expect(run.code).toBe(0);
    expect(singleJsonObject(run)).toEqual({ object: "credits", balance: 42, tier: "pro" });
  });

  test("sends the API key and 4xx exits 1 with the server's code", async () => {
    const server = mockApi((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer dgo_test_key");
      return json({ error: { message: "Invalid or revoked API key.", code: "invalid_api_key" } }, 401);
    });

    const run = await runCli(server.url.origin, ["credits", "--json"]);
    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({ message: "Invalid or revoked API key.", code: "invalid_api_key" });
  });

  test("5xx exits 2", async () => {
    const server = mockApi(() => json({ error: { message: "boom", code: "internal" } }, 500));
    const run = await runCli(server.url.origin, ["credits", "--json"]);
    expect(run.code).toBe(2);
    expect(errorOf(run).message).toBe("boom");
  });

  test("a 2xx body that is not JSON exits 2 as invalid_response", async () => {
    const server = mockApi(() => new Response("<html>nope</html>", { status: 200 }));
    const run = await runCli(server.url.origin, ["credits", "--json"]);
    expect(run.code).toBe(2);
    expect(errorOf(run).code).toBe("invalid_response");
  });

  test("human mode keeps stdout clean of durango: prefixed errors", async () => {
    const server = mockApi(() => json({ error: { message: "nope", code: "invalid_api_key" } }, 401));
    const run = await runCli(server.url.origin, ["credits"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("durango: nope");
  });
});

describe("models list", () => {
  test("forwards --type and prints the list", async () => {
    const server = mockApi((_request, url) => {
      expect(url.pathname).toBe("/api/v1/models");
      expect(url.searchParams.get("type")).toBe("video");
      return json({ object: "list", data: [{ id: "google/veo-3.1-fast" }] });
    });

    const run = await runCli(server.url.origin, ["models", "list", "--type", "video", "--json"]);
    expect(run.code).toBe(0);
    expect((singleJsonObject(run).data as unknown[]).length).toBe(1);
  });

  test("a --type outside the declared choices is a usage error and never hits the API", async () => {
    let calls = 0;
    const server = mockApi(() => {
      calls += 1;
      return json({});
    });

    const run = await runCli(server.url.origin, ["models", "list", "--type", "bogus", "--json"]);
    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({
      message: "--type must be one of: chat, image, video.",
      code: "usage_error",
    });
    expect(calls).toBe(0);
  });

  test("a value flag with no value is a usage error", async () => {
    const server = mockApi(() => json({}));
    const run = await runCli(server.url.origin, ["download", "vid_1", "--out", "--json"]);
    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({ message: "--out requires a value.", code: "usage_error" });
  });
});

describe("video generate --wait", () => {
  test("polls until terminal and emits the final run object", async () => {
    let polls = 0;
    const server = mockApi(async (request, url) => {
      if (request.method === "POST" && url.pathname === "/api/v1/videos/generations") {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.model).toBe("google/veo-3.1-fast");
        expect(body.prompt).toBe("a neon market");
        return json({ id: "run_1", status: "queued" });
      }
      if (url.pathname === "/api/v1/videos/generations/run_1") {
        polls += 1;
        return json(
          polls < 2
            ? { id: "run_1", status: "running", progress: 0.5 }
            : { id: "run_1", status: "completed", data: [{ id: "vid_1" }] },
        );
      }
      return json({ error: { message: `unexpected ${url.pathname}`, code: "unexpected" } }, 500);
    });

    const run = await runCli(server.url.origin, [
      "video", "generate",
      "--model", "google/veo-3.1-fast",
      "--prompt", "a neon market",
      "--poll-interval", "0.05",
      "--json",
    ]);

    expect(run.code).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(singleJsonObject(run)).toMatchObject({ id: "run_1", status: "completed" });
  });

  test("a failed run exits 1 with the job's message", async () => {
    const server = mockApi((request, url) => {
      if (request.method === "POST") return json({ id: "run_2", status: "queued" });
      if (url.pathname === "/api/v1/videos/generations/run_2") {
        return json({ id: "run_2", status: "failed", error: { message: "provider rejected the prompt" } });
      }
      return json({}, 500);
    });

    const run = await runCli(server.url.origin, [
      "video", "generate", "--model", "m", "--prompt", "p", "--poll-interval", "0.05", "--json",
    ]);
    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({ message: "provider rejected the prompt", code: "generation_failed" });
  });
});

describe("timeouts", () => {
  test("a hung request aborts at DURANGO_HTTP_TIMEOUT_MS and exits 2", async () => {
    const server = mockApi(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(json({})), 10_000)),
    );

    const started = Date.now();
    const run = await runCli(server.url.origin, ["credits", "--json"], {
      DURANGO_HTTP_TIMEOUT_MS: "300",
    });

    expect(run.code).toBe(2);
    expect(errorOf(run).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("--wait gives up on its own budget and exits 1 with the job still running", async () => {
    const server = mockApi((request) =>
      json(request.method === "POST" ? { id: "run_3", status: "queued" } : { id: "run_3", status: "running" }),
    );

    const run = await runCli(server.url.origin, [
      "video", "generate", "--model", "m", "--prompt", "p",
      "--poll-interval", "0.05", "--timeout", "0.005", "--json",
    ]);

    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({
      message: "Timed out waiting for video generation.",
      code: "timeout",
    });
  });
});

describe("video upload", () => {
  test("sends the real filename and content type, with --name as its own field", async () => {
    const source = join(WORK_DIR, "clip.mp4");
    writeFileSync(source, Buffer.from("fake-mp4-bytes"));

    let observed: { filename?: string; type?: string; name?: unknown; size?: number } = {};
    const server = mockApi(async (request, url) => {
      expect(url.pathname).toBe("/api/v1/videos/uploads");
      expect(request.headers.get("content-type") || "").toContain("multipart/form-data");
      const form = await request.formData();
      const file = form.get("file") as File;
      observed = {
        filename: file.name,
        type: file.type,
        name: form.get("name"),
        size: file.size,
      };
      return json({ id: "up_1", object: "video.upload", name: "match one" }, 201);
    });

    const run = await runCli(server.url.origin, [
      "video", "upload", source, "--name", "match one", "--json",
    ]);

    expect(run.code).toBe(0);
    expect(observed.filename).toBe("clip.mp4");
    expect(observed.type).toBe("video/mp4");
    expect(observed.name).toBe("match one");
    expect(observed.size).toBe(14);
    expect(singleJsonObject(run).id).toBe("up_1");
  });
});

describe("video edit --source-file", () => {
  test("uploads, polls, downloads to --out, and prints one JSON object", async () => {
    const source = join(WORK_DIR, "match.mp4");
    const outputPath = join(WORK_DIR, "highlights.mp4");
    writeFileSync(source, Buffer.from("source-bytes"));
    const rendered = Buffer.alloc(1024 * 512, 7);

    let polls = 0;
    const server = mockApi(async (request, url) => {
      if (request.method === "POST" && url.pathname === "/api/v1/videos/uploads") {
        await request.formData();
        return json({ id: "up_9", object: "video.upload" }, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/videos/edits") {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.source_video_ids).toEqual(["up_9"]);
        return json({ id: "edit_9", status: "queued" });
      }
      if (url.pathname === "/api/v1/videos/edits/edit_9") {
        polls += 1;
        return json(
          polls < 2
            ? { id: "edit_9", status: "rendering", progress: 0.3 }
            : {
                id: "edit_9",
                status: "completed",
                data: [{ id: "vid_9", url: "/api/v1/videos/vid_9/content" }],
              },
        );
      }
      if (url.pathname === "/api/v1/videos/vid_9/content") {
        return new Response(rendered, { headers: { "content-type": "video/mp4" } });
      }
      return json({ error: { message: `unexpected ${url.pathname}`, code: "unexpected" } }, 500);
    });

    const run = await runCli(server.url.origin, [
      "video", "edit",
      "--source-file", source,
      "--prompt", "45s highlight reel",
      "--poll-interval", "0.05",
      "--out", outputPath,
      "--json",
    ]);

    expect(run.code).toBe(0);
    expect(statSync(outputPath).size).toBe(rendered.byteLength);
    expect(singleJsonObject(run)).toMatchObject({ id: "edit_9", status: "completed", output_path: outputPath });
  });

  test("a later failure still reports the ids of the uploads that succeeded", async () => {
    const source = join(WORK_DIR, "orphan.mp4");
    writeFileSync(source, Buffer.from("source-bytes"));

    const server = mockApi(async (request, url) => {
      if (request.method === "POST" && url.pathname === "/api/v1/videos/uploads") {
        await request.formData();
        return json({ id: "up_orphan" }, 201);
      }
      return json({ error: { message: "planner unavailable", code: "planner_down" } }, 503);
    });

    const run = await runCli(server.url.origin, [
      "video", "edit", "--source-file", source, "--prompt", "reel", "--json",
    ]);

    expect(run.code).toBe(2);
    expect(errorOf(run)).toEqual({
      message: "planner unavailable",
      code: "planner_down",
      uploaded_ids: ["up_orphan"],
    });
  });
});

describe("image generate --out", () => {
  test("writes the decoded image and keeps the base64 payload out of stdout", async () => {
    const outputPath = join(WORK_DIR, "lighthouse.png");
    const bytes = Buffer.from("pretend-png-bytes");
    const server = mockApi(async (request, url) => {
      expect(url.pathname).toBe("/api/v1/images/generations");
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.response_format).toBe("b64_json");
      return json({
        object: "list",
        data: [{ id: "img_1", b64_json: bytes.toString("base64"), content_type: "image/png" }],
      });
    });

    const run = await runCli(server.url.origin, [
      "image", "generate", "--model", "m", "--prompt", "a lighthouse", "--out", outputPath, "--json",
    ]);

    expect(run.code).toBe(0);
    expect(statSync(outputPath).size).toBe(bytes.byteLength);
    expect(run.stdout).not.toContain(bytes.toString("base64"));
    const parsed = singleJsonObject(run);
    expect(parsed.output_path).toBe(outputPath);
    expect((parsed.data as Record<string, unknown>[])[0]).toEqual({
      id: "img_1",
      content_type: "image/png",
    });
  });
});

describe("download", () => {
  test("streams the body to --out and reports the byte count", async () => {
    const outputPath = join(WORK_DIR, "downloaded.mp4");
    const payload = Buffer.alloc(1024 * 1024, 3);
    const server = mockApi((_request, url) => {
      expect(url.pathname).toBe("/api/v1/videos/vid_1");
      return new Response(payload, { headers: { "content-type": "video/mp4" } });
    });

    const run = await runCli(server.url.origin, [
      "download", "vid_1", "--type", "video", "--out", outputPath, "--json",
    ]);

    expect(run.code).toBe(0);
    expect(statSync(outputPath).size).toBe(payload.byteLength);
    expect(singleJsonObject(run)).toMatchObject({
      object: "download",
      bytes: payload.byteLength,
      content_type: "video/mp4",
    });
  });
});

describe("failed downloads", () => {
  test("a body that ends cleanly short of Content-Length is a truncated_download", async () => {
    const outputPath = join(WORK_DIR, "truncated.mp4");
    // Chunked framing plus a (larger) Content-Length is what a mangling proxy produces:
    // the read loop sees a clean end-of-body, so only the length check catches the loss.
    const { origin } = rawApi((write) => {
      write("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1048576\r\nTransfer-Encoding: chunked\r\n\r\n");
      write("1000\r\n");
      write(new Uint8Array(4096));
      write("\r\n0\r\n\r\n");
    });

    const run = await runCli(origin, ["download", "vid_1", "--type", "video", "--out", outputPath, "--json"]);

    expect(run.code).toBe(2);
    expect(errorOf(run).code).toBe("truncated_download");
    expect(String(errorOf(run).message)).toContain("expected 1048576 bytes but received 4096");
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(`${outputPath}.part`)).toBe(false);
  });

  test("a body cut off mid-transfer exits 2 and leaves no file behind", async () => {
    const outputPath = join(WORK_DIR, "cut-off.mp4");
    const { origin } = rawApi((write) => {
      write("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n");
      write(new Uint8Array(4096));
    });

    const run = await runCli(origin, ["download", "vid_1", "--type", "video", "--out", outputPath, "--json"]);

    // Bun's fetch raises ECONNRESET on the early EOF before the length check can run.
    // Either way it is a retryable exit 2 with nothing left on disk.
    expect(run.code).toBe(2);
    expect(["truncated_download", "connection_error"]).toContain(String(errorOf(run).code));
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(`${outputPath}.part`)).toBe(false);
  });

  test("an unwritable --out is a clean usage error, not a raw stack trace", async () => {
    const outputPath = join(WORK_DIR, "no-such-dir", "clip.mp4");
    const payload = Buffer.alloc(256 * 1024, 5);
    const server = mockApi(() => new Response(payload, { headers: { "content-type": "video/mp4" } }));

    const run = await runCli(server.url.origin, [
      "download", "vid_1", "--type", "video", "--out", outputPath, "--json",
    ]);

    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("write_error");
    expect(run.stderr).not.toContain("at ");
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe("connection failures", () => {
  test("a refused connection exits 2 as connection_error, not exit 1", async () => {
    const dead = mockApi(() => json({}));
    const origin = dead.url.origin;
    dead.stop(true);

    const run = await runCli(origin, ["credits", "--json"]);

    expect(run.code).toBe(2);
    expect(errorOf(run).code).toBe("connection_error");
  });
});

describe("boolean flags with an explicit value", () => {
  test("--wait false does not poll and does not become a positional", async () => {
    let polls = 0;
    const server = mockApi((request, url) => {
      if (request.method === "POST" && url.pathname === "/api/v1/videos/generations") {
        return json({ id: "run_nw", status: "queued" });
      }
      polls += 1;
      return json({ id: "run_nw", status: "completed" });
    });

    const run = await runCli(server.url.origin, [
      "video", "generate", "--model", "m", "--prompt", "p", "--wait", "false", "--json",
    ]);

    expect(run.code).toBe(0);
    expect(polls).toBe(0);
    expect(singleJsonObject(run)).toMatchObject({ id: "run_nw", status: "queued" });
  });
});

describe("unknown flags", () => {
  test("a typo on a billable command fails before any request is made", async () => {
    let calls = 0;
    const server = mockApi(() => {
      calls += 1;
      return json({ id: "edit_x", status: "queued" });
    });

    const run = await runCli(server.url.origin, [
      "video", "edit", "--source", "up_1", "--prompt", "reel", "--outt", join(WORK_DIR, "reel.mp4"), "--json",
    ]);

    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("usage_error");
    expect(String(errorOf(run).message)).toContain("--outt");
    expect(calls).toBe(0);
  });

  test("help paths stay permissive", async () => {
    const server = mockApi(() => json({}));
    const run = await runCli(server.url.origin, ["video", "edit", "--help", "--outt", "x", "--json"]);
    expect(run.code).toBe(0);
    expect(singleJsonObject(run).object).toBe("cli.schema");
  });
});

describe("number flags", () => {
  test("--max-duration abc fails before anything is uploaded", async () => {
    const source = join(WORK_DIR, "never-uploaded.mp4");
    writeFileSync(source, Buffer.from("source-bytes"));

    let uploads = 0;
    const server = mockApi(async (request, url) => {
      if (url.pathname === "/api/v1/videos/uploads") {
        uploads += 1;
        await request.formData();
        return json({ id: "up_never" }, 201);
      }
      return json({ id: "edit_never", status: "queued" });
    });

    const run = await runCli(server.url.origin, [
      "video", "edit", "--source-file", source, "--prompt", "reel", "--max-duration", "abc", "--json",
    ]);

    expect(run.code).toBe(1);
    expect(errorOf(run)).toEqual({ message: "--max-duration must be a number.", code: "usage_error" });
    expect(uploads).toBe(0);
  });
});

describe("end of flags", () => {
  test("-- makes the following token a positional, even when it looks like a flag", async () => {
    writeFileSync(join(WORK_DIR, "--weird.mp4"), Buffer.from("weird-bytes"));

    let filename: string | undefined;
    const server = mockApi(async (request) => {
      const form = await request.formData();
      filename = (form.get("file") as File).name;
      return json({ id: "up_weird" }, 201);
    });

    const run = await runCli(server.url.origin, ["video", "upload", "--json", "--", "--weird.mp4"]);

    expect(run.code).toBe(0);
    expect(filename).toBe("--weird.mp4");
    expect(singleJsonObject(run).id).toBe("up_weird");
  });
});

describe("config migration", () => {
  test("help and version never rewrite a stored legacy host", async () => {
    const configHome = join(WORK_DIR, "legacy-config");
    const configPath = join(configHome, "durango-cli", "config.json");
    const seeded = `${JSON.stringify({ apiKey: "dgo_seeded", baseUrl: "https://heydurango.com" }, null, 2)}\n`;
    mkdirSync(join(configHome, "durango-cli"), { recursive: true });
    writeFileSync(configPath, seeded);

    for (const args of [["help", "--json"], ["version", "--json"], ["help"], ["--version"]]) {
      const run = await runCli("unused", args, {
        XDG_CONFIG_HOME: configHome,
        DURANGO_BASE_URL: undefined,
        DURANGO_API_KEY: undefined,
      });
      expect(run.code).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(seeded);
      expect(run.stderr).not.toContain("no longer served");
    }
  });
});

describe("login", () => {
  test("survives a missing browser opener and still emits one JSON object", async () => {
    const server = mockApi(async (request, url) => {
      if (url.pathname === "/api/cli/auth/start") {
        return json({
          authorize_url: `${url.origin}/cli/authorize?code=ABCD-1234`,
          attempt_id: "att_1",
          poll_token: "tok_1",
          code: "ABCD-1234",
          interval: 0.05,
          expires_at: Date.now() + 5_000,
        });
      }
      if (url.pathname === "/api/cli/auth/status") {
        await request.json();
        return json({ status: "expired" });
      }
      return json({}, 500);
    });

    // No browser opener is reachable: spawn() raises ENOENT asynchronously.
    const run = await runCli(server.url.origin, ["login", "--json"], {
      PATH: join(WORK_DIR, "no-such-bin"),
    });

    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("login_expired");
    expect(run.stderr).not.toContain("Error: spawn");
    // The interactive essentials must reach the caller on stderr in --json mode.
    expect(run.stderr).toContain("ABCD-1234");
    expect(run.stderr).toContain("/cli/authorize?code=ABCD-1234");
    expect(run.stderr).toContain("Waiting for authorization...");
  });

  test("saves the key and prints the login object when authorization lands", async () => {
    const server = mockApi(async (request, url) => {
      if (url.pathname === "/api/cli/auth/start") {
        return json({
          authorize_url: `${url.origin}/cli/authorize`,
          attempt_id: "att_2",
          poll_token: "tok_2",
          code: "WXYZ-9999",
          interval: 0.05,
          expires_at: Date.now() + 5_000,
        });
      }
      if (url.pathname === "/api/cli/auth/status") {
        await request.json();
        return json({ status: "authorized" });
      }
      if (url.pathname === "/api/cli/auth/complete") {
        await request.json();
        return json({ api_key: "dgo_new_key", user: { email: "agent@example.com" } });
      }
      return json({}, 500);
    });

    const run = await runCli(server.url.origin, ["login", "--json"], {
      PATH: join(WORK_DIR, "no-such-bin"),
      XDG_CONFIG_HOME: join(WORK_DIR, "login-config"),
    });

    expect(run.code).toBe(0);
    expect(singleJsonObject(run)).toMatchObject({ object: "login", authenticated: true });
    const saved = await Bun.file(
      join(WORK_DIR, "login-config", "durango-cli", "config.json"),
    ).json();
    expect(saved.apiKey).toBe("dgo_new_key");
  });
});

describe("--json contract", () => {
  test("every invocation writes exactly one JSON object on stdout", async () => {
    const source = join(WORK_DIR, "contract.mp4");
    writeFileSync(source, Buffer.from("bytes"));

    const server = mockApi(async (request, url) => {
      if (url.pathname === "/api/v1/credits") return json({ object: "credits", balance: 1 });
      if (url.pathname === "/api/v1/models") return json({ object: "list", data: [] });
      if (request.method === "POST" && url.pathname === "/api/v1/videos/uploads") {
        await request.formData();
        return json({ id: "up_c" }, 201);
      }
      return json({ error: { message: "gone", code: "http_404" } }, 404);
    });

    const invocations: string[][] = [
      ["help", "--json"],
      ["version", "--json"],
      ["whoami", "--json"],
      ["credits", "--json"],
      ["models", "list", "--json"],
      ["video", "upload", source, "--json"],
      ["uploads", "get", "up_missing", "--json"],
      ["models", "list", "--type", "nope", "--json"],
      ["frobnicate", "--json"],
    ];

    for (const args of invocations) {
      const run = await runCli(server.url.origin, args);
      const parsed = singleJsonObject(run);
      const failed = "error" in parsed;
      expect(failed ? run.code !== 0 : run.code === 0).toBe(true);
    }
  });
});
