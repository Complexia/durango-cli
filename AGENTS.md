# Driving durango-cli from a coding agent

This file teaches an autonomous agent (Claude Code and friends) how to create and edit
video with the Durango CLI end to end. Every step is a single shell command with
deterministic JSON output — no screen scraping, no interactive prompts except `login`.

## 0. Rules of engagement

1. **Always pass `--json`.** stdout is then exactly one JSON object per invocation, human
   text and progress lines are suppressed. **stderr is not part of that contract** — read
   it for context, never parse it. Only `login` writes anything essential there (see §1a).
2. **Check the exit code**, not the text: `0` success, `1` **your** problem — fix the command,
   do not retry it unchanged (unknown or malformed flags, 4xx, missing credentials, an
   unwritable `--out`, your `--timeout` budget elapsing), `2` **the other end's** problem —
   retrying after a backoff is reasonable (5xx, a 2xx body the CLI could not parse, a single
   request timing out, an unreachable host, a truncated download).
3. **Errors are structured**: `{"error":{"message":"...","code":"..."}}` on stdout with a
   nonzero exit. `code` is stable enough to branch on (`usage_error`, `missing_api_key`,
   `timeout`, `invalid_response`, `connection_error`, `truncated_download`, `write_error`,
   `edit_failed`, `generation_failed`, `http_404`, or the server's own code). The error object
   may carry extra fields describing work that already succeeded — today that is
   `uploaded_ids` (see §3a).
4. **Discover the surface at runtime** instead of guessing flags:
   ```bash
   durango help --json
   ```
   That object has `commands[]` with `name`, `args[]`, `flags[]` (`type`, `default`,
   `choices`, `repeatable`, `required`), plus `global_flags`, `environment`, `exit_codes`.
   The schema is enforced, so a typo fails fast instead of running a paid job with the flag
   ignored: a flag the resolved command does not declare, a value outside `choices`, and a
   non-number for a `"type":"number"` flag are all `usage_error` (exit `1`) raised *before*
   any request. Boolean flags accept `--wait`, `--no-wait`, and `--wait true|false`; `--`
   ends the flags, so everything after it is a positional (`durango video upload -- --odd.mp4`).
5. Long jobs block by default (`--wait`). Prefer that in an agent loop — the command returns
   only when the job is terminal. Use `--no-wait` plus your own polling if you need to do
   other work meanwhile.
6. Never print an API key. `durango whoami --json` returns it masked.

## 1. Preflight

```bash
durango whoami --json
```

- Exit `0` → you have a working key. Note `tier` and `balance`; video work needs credits.
- Exit `1` with `"code":"missing_api_key"` → ask the human to run `durango login`
  (it opens a browser; an agent cannot complete it unattended). If they gave you a key,
  use `--api-key dgo_...` or `durango config set --api-key dgo_...` instead.

Point at a non-default host with `--base-url https://...` (or `DURANGO_BASE_URL`).

### 1a. `login` is the one interactive command

`durango login --json` still needs a human. Because the verification code and authorize URL
are useless after the command finishes, they are printed to **stderr** as they happen —
including in `--json` mode — while stdout keeps the single final object:

```
Verification code: ABCD-1234          <- stderr, human-readable
Login URL: https://durango.sh/...     <- stderr
Waiting for authorization...          <- stderr
{ "object": "login", "authenticated": true, ... }   <- stdout, the one JSON object
```

Relay those stderr lines to the human verbatim, then wait. If no browser opener exists
(headless box, stripped `PATH`), the CLI says so on stderr and keeps waiting — it does not
fail. An expired or unauthorized attempt exits `1` with `login_expired` / `login_timeout`.

## 2. Flow A — generate a video from a prompt

```bash
# 1. Pick a model.
durango models list --type video --json

# 2. Generate. This blocks until the run is terminal, then writes the file.
durango video generate \
  --model google/veo-3.1-fast \
  --prompt "A slow dolly shot through a rainy neon market" \
  --duration 5 --resolution 720p --aspect-ratio 16:9 \
  --out market.mp4 --json
```

The emitted object is the final run object plus `output_path: "market.mp4"`.

Non-blocking variant:

```bash
RUN=$(durango video generate --model google/veo-3.1-fast --prompt "..." --no-wait --json | jq -r .id)
durango video status "$RUN" --json          # repeat until .status is completed|failed

# On completed, the run object's data[] holds the results; data[0].id is the video id.
VIDEO=$(durango video status "$RUN" --json | jq -r '.data[0].id')
durango download "$VIDEO" --type video --out market.mp4 --json
```

`durango video list --json` lists recent generated videos (newest first) if you lose an id.

## 3. Flow B — edit existing footage (the main event)

### 3a. Upload sources

```bash
# Local file (multipart upload).
durango video upload ./match.mp4 --name "match 1" --json

# Or let the server ingest a URL — direct mp4/webm/mov, or an HLS/DASH manifest.
durango video upload --url https://example.com/stream.m3u8 --name match.mp4 --json
```

Both return a `video.upload` object; keep `.id` (e.g. `up_abc`). `duration_seconds`,
`width`, and `height` come back probed, which is useful for sanity-checking a prompt.

`durango uploads list --json`, `durango uploads get <id> --json`, and
`durango uploads delete <id> --json` manage them.

You can skip this step entirely: `durango video edit --source-file ./match.mp4` uploads the
file first and then uses its id. If a later step of that command fails, the error object
carries the ids that did land:

```json
{ "error": { "message": "planner unavailable", "code": "planner_down", "uploaded_ids": ["up_abc"] } }
```

Retry with `--source up_abc` instead of `--source-file` — do not re-upload.

### 3b. Prompt-driven highlight reel

```bash
durango video edit \
  --source up_abc \
  --prompt "45 second highlight reel of the most action-packed exchanges" \
  --max-duration 45 \
  --out highlights.mp4 --json
```

What happens server-side: sources are probed (scene changes, loudness), a planner model
turns your prompt + that metadata into an edit plan, and ffmpeg renders it. The final
object includes `plan.operations` — inspect it to explain or refine the result.

### 3c. Portrait reframe for social

```bash
durango video edit \
  --source up_abc --source up_def \
  --prompt "vertical cut of the best moments, keep the action centered" \
  --aspect-ratio 9:16 --resolution 1080p --max-duration 60 \
  --out reel.mp4 --json
```

1–10 sources per edit; ids may be uploads **or** previously generated video ids, so you can
chain: generate → edit → edit again.

### 3d. Polling explicitly

```bash
EDIT=$(durango video edit --source up_abc --prompt "..." --no-wait --json | jq -r .id)
durango video edits status "$EDIT" --json    # .status: queued|planning|rendering|completed|failed
durango video edits list --limit 20 --json
```

On `completed`, `data[0]` is the result video: download it with

```bash
durango download "$(… .data[0].id)" --type video --out reel.mp4 --json
```

### 3e. Deterministic edits (no AI planning)

When you already know the cuts, pass the plan and skip the planner. `--prompt` becomes
optional:

```bash
cat > plan.json <<'JSON'
[
  { "op": "clip", "source_index": 0, "start": 12.5, "end": 19.0 },
  { "op": "clip", "source_index": 0, "start": 44.0, "end": 51.5 },
  { "op": "reframe", "aspect_ratio": "9:16", "strategy": "center" },
  { "op": "audio", "mode": "keep" }
]
JSON
durango video edit --source up_abc --operations @plan.json --aspect-ratio 9:16 --out cut.mp4 --json
```

Operation vocabulary: `clip` (`source_index`, `start`, `end` — concatenated in order),
`reframe` (`aspect_ratio`, `strategy`), `speed` (`factor`, `scope`), `audio`
(`mode: keep|mute`), `text` (`content`, `position`, `start`, `end`).

## 4. Timeouts and retries

- `--poll-interval` (seconds; default `12` for generation, `5` for edits) and `--timeout`
  (minutes; default `30`) apply to every `--wait` command.
- Two different things carry `"code":"timeout"`, told apart by the exit code:
  - **exit `1`** — your `--timeout` budget elapsed. The job keeps running; recover with
    `durango video edits status <id> --json`, don't resubmit.
  - **exit `2`** — a single HTTP request hit its own cap (120 s for JSON calls, override
    with `DURANGO_HTTP_TIMEOUT_MS`; 1 hour for uploads/downloads, so big transfers are
    never cut short). The server is unresponsive; retry after a backoff.
- Exit `2` means the far end failed; retrying once after a short backoff is reasonable.
  That covers `invalid_response` (a 2xx body the CLI could not parse), `connection_error`
  (refused connection, dead DNS name, reset socket — the request never landed, so a retry
  cannot double-charge you), and `truncated_download` (see below). Exit `1` with
  `usage_error` means *you* need to fix the command; do not retry blindly.
- Long uploads: prefer `--url` ingest when the footage is already reachable over HTTP.
- Downloads stream to disk, so `--out` is safe for multi-gigabyte results — and they are
  failure-safe: bytes land in `<out>.part` and are renamed onto `--out` only after the whole
  body has arrived and matches the server's `Content-Length`. A short or interrupted transfer
  exits `2` (`truncated_download` / `connection_error`) and removes the partial file, so a
  file at `--out` after exit `0` is always the complete result — never a corrupt prefix.
  (A destination that is already a FIFO or a `/dev/*` node cannot be staged, so it is written
  through directly; the length check still applies.) `write_error` covers the local side:
  exit `1` when the destination itself is wrong (missing directory, no permission — fix the
  path), exit `2` when a writable sink died mid-transfer (full disk, a FIFO whose reader
  exited).

## 5. Checklist for a typical task

> "Make a vertical highlight reel from these two clips."

```bash
durango whoami --json                                   # 1. auth + credits
durango video upload ./a.mp4 --json                     # 2. sources → up_a
durango video upload ./b.mp4 --json                     #             → up_b
durango video edit --source up_a --source up_b \
  --prompt "vertical highlight reel of the best moments" \
  --aspect-ratio 9:16 --resolution 1080p --max-duration 60 \
  --out reel.mp4 --json                                 # 3. edit + wait + download
durango video edits list --limit 5 --json               # 4. (optional) audit trail
```

Report `output_path` and, if the human asks *why* a cut was made, show `plan.operations`
from the final object.
