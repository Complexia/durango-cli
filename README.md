# durango-cli

Command-line client for the [Durango](https://durango.sh) API: model discovery, image
generation, video generation, and prompt-driven **video editing** (highlight reels,
reframes, trims) driven entirely from the terminal.

Zero runtime dependencies. Runs on Bun; ships as ESM built with `tsc`.

- Every command supports `--json` for machine-readable output (see [JSON contract](#json-contract)).
- `durango help --json` emits a full command schema, so coding agents can drive the CLI
  without reading these docs. Agent playbook: [AGENTS.md](./AGENTS.md).

## Install

```bash
bun install
bun link          # exposes `durango` and `durango-cli`
```

Or run straight from source:

```bash
bun run src/index.ts help
```

## Auth

```bash
durango login
```

Opens Durango in your browser, signs you in, and saves a CLI API key to
`~/.config/durango-cli/config.json` (honours `XDG_CONFIG_HOME`). If no browser opener is
available the command says so and keeps waiting — open the printed URL yourself. With
`--json`, the verification code and login URL go to stderr so stdout stays a single object.

Alternatives:

```bash
durango config set --api-key dgo_... --base-url https://durango.sh
export DURANGO_API_KEY="dgo_..."
export DURANGO_BASE_URL="https://durango.sh"   # optional; this is the default
durango whoami --api-key dgo_... --base-url https://durango.sh
```

Precedence: `--api-key` / `--base-url` flags → environment → config file → defaults.

```bash
durango whoami     # host, masked key, tier, credit balance
durango credits    # raw credits object
durango version    # CLI version (same as --version)
```

## Commands

### Discovery

```bash
durango models list                 # all models
durango models list --type video    # chat | image | video
```

### Images

```bash
durango image generate \
  --model google/gemini-3-pro-image-preview \
  --prompt "A watercolor lighthouse at dawn" \
  --aspect-ratio 16:9 \
  --out lighthouse.png
```

Flags: `--model` (required), `--prompt` (required), `--aspect-ratio` (default `1:1`),
`--image-size` (default `1K`), `--source-image` (repeatable), `--response-format`
(`url|b64_json`, forced to `b64_json` with `--out`), `--private`, `--out`.

### Video generation

```bash
durango video generate \
  --model google/veo-3.1-fast \
  --prompt "A slow dolly shot through a rainy neon market" \
  --duration 5 \
  --resolution 720p \
  --out market.mp4
```

Starts an async run, polls until it finishes (`--wait` is the default), and downloads the
first completed video when `--out` is given. Use `--no-wait` to print the run object and
poll yourself.

Flags: `--model` (required), `--prompt` (required), `--model-id` (repeatable — run the same
prompt across several models), `--aspect-ratio` (default `16:9`), `--resolution` (default
`720p`), `--duration` (default `5`), `--source-image` / `--source-image-id` (repeatable),
`--audio`, `--private`, `--wait`/`--no-wait` (default wait), `--poll-interval` (seconds,
default `12`), `--timeout` (minutes, default `30`), `--out`.

```bash
durango video status <runId>        # fetch one run
durango video list --limit 10       # recent generated videos, newest first
```

### Uploads (bring your own footage)

```bash
durango video upload ./match.mp4 --name "match 1"
durango video upload --url https://example.com/stream.m3u8 --name match.mp4
```

Local files are sent as `multipart/form-data`. `--url` asks the server to ingest the URL —
a direct `mp4`/`webm`/`mov`, or an HLS (`.m3u8`) / DASH (`.mpd`) manifest, which is remuxed
to MP4 during ingest. The response includes the upload `id` used as an edit source.

```bash
durango uploads list --limit 50
durango uploads get <id>
durango uploads delete <id>
```

### Video editing

```bash
# Highlight reel from a local file — uploads it, edits, waits, downloads.
durango video edit \
  --source-file ./match.mp4 \
  --prompt "45 second highlight reel of the best exchanges" \
  --max-duration 45 \
  --out highlights.mp4

# Portrait reframe across two already-uploaded sources.
durango video edit \
  --source up_abc --source up_def \
  --prompt "vertical cut of the most action-packed moments" \
  --aspect-ratio 9:16 --resolution 1080p \
  --out reel.mp4
```

Flags: `--source <id>` (repeatable; upload ids **or** generated video ids, 1–10 total),
`--source-file <path>` (repeatable; uploaded first, then used as a source), `--prompt`,
`--aspect-ratio` (`9:16|16:9|1:1|original`, default `original`), `--resolution`
(`720p|1080p|original`, default `original`), `--max-duration` (seconds), `--model`
(planner chat model), `--operations` (explicit plan, see below), `--webhook-url`,
`--wait`/`--no-wait` (default wait), `--poll-interval` (seconds, default `5`), `--timeout`
(minutes, default `30`), `--out`.

Results are stored as regular Durango videos, so they show up in `durango video list` and
can be re-downloaded with `durango download <id> --type video --out file.mp4`.

```bash
durango video edits status <id>     # status, progress, the generated plan, results
durango video edits list --limit 20
```

**Deterministic edits.** Skip AI planning by passing the plan directly; `--prompt` then
becomes optional:

```bash
durango video edit --source up_abc --aspect-ratio 9:16 --operations @plan.json --out cut.mp4
```

```json
[
  { "op": "clip", "source_index": 0, "start": 12.5, "end": 19.0 },
  { "op": "clip", "source_index": 0, "start": 44.0, "end": 51.5 },
  { "op": "reframe", "aspect_ratio": "9:16", "strategy": "center" },
  { "op": "audio", "mode": "keep" }
]
```

`--operations` accepts inline JSON, `@file.json`, an array, or an object with an
`operations` array.

### Files

```bash
durango download <url-or-id> --type image|video --out <path>
```

Accepts an absolute URL, an `/api/...` path, or a bare asset id paired with `--type`. The
response is streamed to disk, so gigabyte-scale edit results never sit in memory.

Downloads are also failure-safe. Bytes are written to `<out>.part` and renamed onto `--out`
only once the whole body has arrived and matches the server's `Content-Length`; a short or
interrupted transfer exits `2` (`truncated_download` / `connection_error`) and removes the
partial file. A file at `--out` after a successful run is therefore always complete, never a
corrupt prefix. A destination that already exists as a FIFO or `/dev/*` node cannot be staged
or removed, so it is written through directly and only the length check applies.

## JSON contract

Pass `--json` to any command:

- stdout carries **exactly one** JSON object; all human text is suppressed.
- stderr is **not** part of the contract. Progress lines are silenced while polling, but
  notices and `login`'s verification code / authorize URL are written there so an
  interactive flow is still completable. Never parse stderr.
- Errors are `{"error":{"message":"...","code":"..."}}` on stdout, with a nonzero exit. The
  error object may carry extra fields for work that already succeeded — `video edit
  --source-file` adds `uploaded_ids` so a retry can reuse them instead of re-uploading.
- When `--out` is used with `--json`, the emitted object is the final API object plus an
  extra `output_path` field pointing at the file that was written. Inline `b64_json` blobs
  are stripped from that object since the bytes are already on disk.

Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0`  | success |
| `1`  | usage or client error — fix the command, don't retry it (unknown or malformed flags, 4xx responses, missing credentials, an `--out` path that cannot be written (`write_error`), `--timeout` elapsed) |
| `2`  | server or transport error — retrying after a backoff is reasonable (5xx responses, unparseable responses (`invalid_response`), per-request timeouts, unreachable hosts (`connection_error`), short transfers (`truncated_download`), a sink that died mid-write (`write_error`)) |

The parser validates against the same schema `help --json` publishes, before any request is
made: flags that take a value error out when the value is missing (`--out --json` is a usage
error, not a silent no-op), values outside a flag's documented `choices` are rejected, a
`number` flag given `abc` is rejected, and a flag the command does not declare is rejected
rather than ignored (`--outt` never runs a paid render that writes nothing). Boolean flags
accept `--wait`, `--no-wait`, and an explicit `--wait true|false`; `--` ends the flags, so
everything after it is treated as a positional.

```bash
durango video list --json | jq '.data[0].id'
durango video edit --source up_1 --prompt "..." --json || echo "failed with $?"
```

## Agent usage

Coding agents (Claude Code, etc.) can discover the entire surface at runtime:

```bash
durango help --json     # command schema: names, args, flags, types, defaults, examples
durango help video edit # human help for one command
```

The schema lists every command with its flags (`type`, `default`, `choices`, `repeatable`,
`required`), the global flags, environment variables, and exit codes. Combine with `--json`
on every call and no output parsing is needed. End-to-end recipes live in
[AGENTS.md](./AGENTS.md).

## Development

```bash
bun run typecheck
bun run build      # tsc -> dist/
bun test
bun run src/index.ts help
```

Layout: `src/index.ts` (entry + dispatch), `src/commands/*` (one module per command group),
`src/lib/*` (`args`, `config`, `http`, `output`, `files`, `poll`, `help`). The command
schema in `src/lib/help.ts` drives both human help and `help --json`, so new flags are
documented in one place.

## Environment

| Variable | Purpose |
| -------- | ------- |
| `DURANGO_API_KEY` | API key used when `--api-key` is not passed |
| `DURANGO_BASE_URL` | Base URL used when `--base-url` is not passed (default `https://durango.sh`) |
| `XDG_CONFIG_HOME` | Config root; config lives at `$XDG_CONFIG_HOME/durango-cli/config.json` |
| `DURANGO_HTTP_TIMEOUT_MS` | Per-request timeout for JSON API calls (default `120000`). Uploads and downloads use a 1 hour cap so large transfers are never cut short |
| `DURANGO_DEBUG` | Print stack traces for unexpected errors |

A config file still pointing at the retired `heydurango.com` host is rewritten to
`https://durango.sh` with a one-line notice on stderr — lazily, the first time a command
actually resolves the host for a request. `durango help` and `durango version` never read or
write the config file.
