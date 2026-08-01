import { DEFAULT_BASE_URL } from "./config.js";

export const CLI_VERSION = "0.4.0";

export type FlagType = "string" | "number" | "boolean";

export type FlagSpec = {
  name: string;
  type: FlagType;
  description: string;
  required?: boolean;
  repeatable?: boolean;
  default?: string | number | boolean;
  choices?: string[];
};

export type ArgSpec = {
  name: string;
  required: boolean;
  description: string;
};

export type CommandSpec = {
  name: string;
  group: string;
  summary: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  examples: string[];
  api?: string;
};

export const GLOBAL_FLAGS: FlagSpec[] = [
  {
    name: "json",
    type: "boolean",
    default: false,
    description: "Emit exactly one JSON object on stdout and suppress human output. Errors become {\"error\":{\"message\",\"code\"}} with a nonzero exit.",
  },
  {
    name: "base-url",
    type: "string",
    default: DEFAULT_BASE_URL,
    description: "Durango API base URL. Overrides DURANGO_BASE_URL and saved config.",
  },
  {
    name: "api-key",
    type: "string",
    description: "Durango API key (dgo_...). Overrides DURANGO_API_KEY and saved config.",
  },
  {
    name: "help",
    type: "boolean",
    default: false,
    description: "Show help for the CLI, or for the command that precedes it.",
  },
  {
    name: "version",
    type: "boolean",
    default: false,
    description: "Print the CLI version.",
  },
];

const WAIT_FLAGS = (pollDefault: number): FlagSpec[] => [
  {
    name: "wait",
    type: "boolean",
    default: true,
    description: "Poll until the job reaches a terminal state. Use --no-wait to return immediately.",
  },
  {
    name: "poll-interval",
    type: "number",
    default: pollDefault,
    description: "Seconds between status polls while waiting.",
  },
  {
    name: "timeout",
    type: "number",
    default: 30,
    description: "Minutes to wait before giving up.",
  },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    group: "Setup & identity",
    summary: "Show CLI help, or a machine-readable command schema with --json.",
    args: [{ name: "command", required: false, description: "Limit help to one command, e.g. \"video edit\"." }],
    flags: [],
    examples: ["durango help", "durango help --json", "durango help video edit"],
  },
  {
    name: "version",
    group: "Setup & identity",
    summary: "Print the CLI version (same as --version).",
    args: [],
    flags: [],
    examples: ["durango version", "durango version --json"],
  },
  {
    name: "login",
    group: "Setup & identity",
    summary: "Sign in through the browser (device code flow) and save an API key to the config file. With --json the verification code and authorize URL are printed on stderr while stdout keeps the single result object.",
    args: [],
    flags: [
      { name: "base-url", type: "string", default: DEFAULT_BASE_URL, description: "Durango host to log into; also saved to config." },
    ],
    examples: ["durango login"],
    api: "POST /api/cli/auth/start|status|complete",
  },
  {
    name: "config set",
    group: "Setup & identity",
    summary: "Persist an API key and/or base URL to ~/.config/durango-cli/config.json.",
    args: [],
    flags: [
      { name: "api-key", type: "string", description: "API key to save (dgo_...)." },
      { name: "base-url", type: "string", description: "Base URL to save." },
    ],
    examples: ["durango config set --api-key dgo_live_123 --base-url https://durango.sh"],
  },
  {
    name: "whoami",
    group: "Setup & identity",
    summary: "Show the resolved host, masked API key, plan tier, and credit balance.",
    args: [],
    flags: [],
    examples: ["durango whoami", "durango whoami --json"],
    api: "GET /api/v1/credits",
  },
  {
    name: "credits",
    group: "Setup & identity",
    summary: "Print the raw credits object (balance, limit, tier, period end).",
    args: [],
    flags: [],
    examples: ["durango credits --json"],
    api: "GET /api/v1/credits",
  },
  {
    name: "models list",
    group: "Discovery",
    summary: "List models available to your key.",
    args: [],
    flags: [
      { name: "type", type: "string", choices: ["chat", "image", "video"], description: "Filter by model type." },
    ],
    examples: ["durango models list --type video --json"],
    api: "GET /api/v1/models",
  },
  {
    name: "image generate",
    group: "Images",
    summary: "Generate an image synchronously; downloads to --out when provided.",
    args: [],
    flags: [
      { name: "model", type: "string", required: true, description: "Image model id, e.g. google/gemini-3-pro-image-preview." },
      { name: "prompt", type: "string", required: true, description: "Text prompt." },
      { name: "aspect-ratio", type: "string", default: "1:1", description: "Output aspect ratio." },
      { name: "image-size", type: "string", default: "1K", description: "Output size bucket (e.g. 1K, 2K)." },
      { name: "source-image", type: "string", repeatable: true, description: "Reference image URL or data URL. Repeatable." },
      { name: "response-format", type: "string", choices: ["url", "b64_json"], default: "url", description: "Response payload format. Forced to b64_json when --out is set." },
      { name: "private", type: "boolean", default: false, description: "Keep the result out of the public gallery." },
      { name: "out", type: "string", description: "Write the first image to this path." },
    ],
    examples: [
      "durango image generate --model google/gemini-3-pro-image-preview --prompt \"A watercolor lighthouse at dawn\" --out lighthouse.png",
    ],
    api: "POST /api/v1/images/generations",
  },
  {
    name: "video generate",
    group: "Video generation",
    summary: "Start a text/image-to-video run; polls to completion by default and downloads with --out.",
    args: [],
    flags: [
      { name: "model", type: "string", required: true, description: "Video model id, e.g. google/veo-3.1-fast." },
      { name: "prompt", type: "string", required: true, description: "Text prompt." },
      { name: "model-id", type: "string", repeatable: true, description: "Extra model ids to run in the same batch. Repeatable." },
      { name: "aspect-ratio", type: "string", default: "16:9", description: "Output aspect ratio." },
      { name: "resolution", type: "string", default: "720p", description: "Output resolution." },
      { name: "duration", type: "number", default: 5, description: "Clip duration in seconds." },
      { name: "source-image", type: "string", repeatable: true, description: "Reference image URL or data URL. Repeatable." },
      { name: "source-image-id", type: "string", repeatable: true, description: "Reference image id already stored in Durango. Repeatable." },
      { name: "audio", type: "boolean", description: "Request generated audio (model dependent)." },
      { name: "private", type: "boolean", default: false, description: "Keep the result out of the public gallery." },
      ...WAIT_FLAGS(12),
      { name: "out", type: "string", description: "Write the first completed video to this path." },
    ],
    examples: [
      "durango video generate --model google/veo-3.1-fast --prompt \"A slow dolly through a rainy neon market\" --out market.mp4",
      "durango video generate --model google/veo-3.1-fast --prompt \"...\" --no-wait --json",
    ],
    api: "POST /api/v1/videos/generations",
  },
  {
    name: "video status",
    group: "Video generation",
    summary: "Fetch a generation run by id.",
    args: [{ name: "runId", required: true, description: "Run id returned by video generate." }],
    flags: [],
    examples: ["durango video status run_123 --json"],
    api: "GET /api/v1/videos/generations/{id}",
  },
  {
    name: "video list",
    group: "Video generation",
    summary: "List recent generated videos (generations and edit outputs), newest first.",
    args: [],
    flags: [{ name: "limit", type: "number", default: 20, description: "Maximum number of videos to return." }],
    examples: ["durango video list --limit 5 --json"],
    api: "GET /api/v1/videos",
  },
  {
    name: "video upload",
    group: "Uploads",
    summary: "Bring your own video into Durango as an editing source, from a local file or a URL.",
    args: [{ name: "file", required: false, description: "Local video file to upload (omit when using --url)." }],
    flags: [
      { name: "url", type: "string", description: "Ingest from a URL instead of a local file (direct mp4/webm/mov, or an HLS/DASH manifest)." },
      { name: "name", type: "string", description: "Display name for the upload. Defaults to the file name." },
    ],
    examples: [
      "durango video upload ./roll1.mp4",
      "durango video upload --url https://example.com/stream.m3u8 --name match.mp4 --json",
    ],
    api: "POST /api/v1/videos/uploads",
  },
  {
    name: "uploads list",
    group: "Uploads",
    summary: "List your uploaded source videos, newest first.",
    args: [],
    flags: [{ name: "limit", type: "number", default: 50, description: "Maximum number of uploads to return." }],
    examples: ["durango uploads list --json"],
    api: "GET /api/v1/videos/uploads",
  },
  {
    name: "uploads get",
    group: "Uploads",
    summary: "Fetch one upload's metadata.",
    args: [{ name: "id", required: true, description: "Upload id." }],
    flags: [],
    examples: ["durango uploads get up_123 --json"],
    api: "GET /api/v1/videos/uploads/{id}",
  },
  {
    name: "uploads delete",
    group: "Uploads",
    summary: "Delete an upload and its stored object.",
    args: [{ name: "id", required: true, description: "Upload id." }],
    flags: [],
    examples: ["durango uploads delete up_123"],
    api: "DELETE /api/v1/videos/uploads/{id}",
  },
  {
    name: "video edit",
    group: "Video editing",
    summary: "Prompt-driven edit of one or more source videos (highlight reels, reframes, trims). Polls to completion by default.",
    args: [],
    flags: [
      { name: "source", type: "string", repeatable: true, description: "Source video id (an upload id or a generated video id). Repeatable, 1-10 total sources." },
      { name: "source-file", type: "string", repeatable: true, description: "Local file to upload first and then use as a source. Repeatable." },
      { name: "prompt", type: "string", description: "What the edit should do, e.g. \"45s highlight reel of the best action\". Required unless the API is given an explicit plan." },
      { name: "aspect-ratio", type: "string", choices: ["9:16", "16:9", "1:1", "original"], default: "original", description: "Output aspect ratio (center crop/scale)." },
      { name: "resolution", type: "string", choices: ["720p", "1080p", "original"], default: "original", description: "Output resolution." },
      { name: "max-duration", type: "number", description: "Target/max output length in seconds." },
      { name: "model", type: "string", description: "Planner chat model id. Defaults to the Durango default planner." },
      { name: "operations", type: "string", description: "Explicit edit plan as JSON (array of operations, or @plan.json). Skips AI planning; makes --prompt optional." },
      { name: "webhook-url", type: "string", description: "URL to POST the terminal edit object to on completion or failure." },
      ...WAIT_FLAGS(5),
      { name: "out", type: "string", description: "Download the first result video to this path when the edit completes." },
    ],
    examples: [
      "durango video edit --source-file ./match.mp4 --prompt \"45s highlight reel of the best exchanges\" --max-duration 45 --out highlights.mp4",
      "durango video edit --source up_1 --source up_2 --prompt \"portrait reframe of the best moments\" --aspect-ratio 9:16 --resolution 1080p --out reel.mp4",
      "durango video edit --source up_1 --prompt \"...\" --no-wait --json",
    ],
    api: "POST /api/v1/videos/edits",
  },
  {
    name: "video edits status",
    group: "Video editing",
    summary: "Fetch an edit job by id (status, progress, plan, results).",
    args: [{ name: "id", required: true, description: "Edit job id." }],
    flags: [],
    examples: ["durango video edits status edit_123 --json"],
    api: "GET /api/v1/videos/edits/{id}",
  },
  {
    name: "video edits list",
    group: "Video editing",
    summary: "List recent edit jobs, newest first.",
    args: [],
    flags: [{ name: "limit", type: "number", default: 20, description: "Maximum number of jobs to return." }],
    examples: ["durango video edits list --json"],
    api: "GET /api/v1/videos/edits",
  },
  {
    name: "download",
    group: "Files",
    summary: "Download an image or video by id, API path, or absolute URL.",
    args: [{ name: "url-or-id", required: true, description: "Absolute URL, /api/... path, or asset id (pair ids with --type)." }],
    flags: [
      { name: "type", type: "string", choices: ["image", "video"], description: "Asset type when passing a bare id." },
      { name: "out", type: "string", required: true, description: "Destination file path." },
    ],
    examples: ["durango download vid_123 --type video --out clip.mp4"],
    api: "GET /api/v1/videos/{id} | GET /api/v1/images/{id}",
  },
];

export const ENVIRONMENT = [
  { name: "DURANGO_API_KEY", description: "API key used when --api-key is not passed." },
  { name: "DURANGO_BASE_URL", description: `Base URL used when --base-url is not passed. Defaults to ${DEFAULT_BASE_URL}.` },
  { name: "XDG_CONFIG_HOME", description: "Config directory root. Config lives at $XDG_CONFIG_HOME/durango-cli/config.json (default ~/.config)." },
  { name: "DURANGO_HTTP_TIMEOUT_MS", description: "Per-request timeout for JSON API calls (default 120000). Uploads and downloads use a 1 hour cap instead." },
  { name: "DURANGO_DEBUG", description: "Set to any value to print stack traces for unexpected errors (human mode only)." },
];

export const EXIT_CODES = [
  { code: 0, meaning: "success" },
  { code: 1, meaning: "usage or client error, do not retry unchanged (unknown or malformed flags, 4xx responses, missing credentials, an unwritable --out path, --timeout budget elapsed)" },
  { code: 2, meaning: "server or transport error, retrying after a backoff is reasonable (5xx responses, unparseable responses, per-request timeouts, connection_error, truncated_download, a sink that died mid-write)" },
];

/** Machine-readable schema emitted by `durango help --json`. */
export function helpSchema() {
  return {
    object: "cli.schema",
    name: "durango",
    version: CLI_VERSION,
    description: "Command-line client for the Durango API: chat models, image generation, video generation, and prompt-driven video editing.",
    usage: "durango <command> [args] [flags]",
    default_base_url: DEFAULT_BASE_URL,
    config_path: "$XDG_CONFIG_HOME/durango-cli/config.json (default ~/.config/durango-cli/config.json)",
    json_output: {
      flag: "--json",
      description: "Prints exactly one JSON object on stdout; all human output is suppressed. stderr is not part of this contract: interactive essentials (the login verification code and authorize URL) and notices are written there.",
      error_shape: { error: { message: "string", code: "string" } },
      error_details: "The error object may carry extra fields describing work already done, e.g. uploaded_ids when --source-file uploads succeeded before the failure.",
    },
    exit_codes: EXIT_CODES,
    global_flags: GLOBAL_FLAGS,
    environment: ENVIRONMENT,
    commands: COMMANDS,
  };
}

/** Longest command whose name is a prefix of the positional arguments. */
export function findCommand(positionals: string[]): CommandSpec | undefined {
  const joined = positionals.join(" ");
  let best: CommandSpec | undefined;
  for (const command of COMMANDS) {
    if (joined === command.name || joined.startsWith(`${command.name} `)) {
      if (!best || command.name.length > best.name.length) best = command;
    }
  }
  return best;
}

/**
 * Flag schema the parser validates against: global flags plus the flags of the
 * command being invoked. Keeping this derived from COMMANDS means `help --json`
 * can never advertise a choice the parser ignores.
 */
export function flagTable(positionals: string[] = []): ReadonlyMap<string, FlagSpec> {
  const table = new Map<string, FlagSpec>();
  for (const flag of GLOBAL_FLAGS) table.set(flag.name, flag);
  for (const flag of findCommand(positionals)?.flags ?? []) table.set(flag.name, flag);
  return table;
}

function usageLine(command: CommandSpec) {
  const args = command.args
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  const required = command.flags
    .filter((flag) => flag.required)
    .map((flag) => `--${flag.name} <${flag.type === "boolean" ? "bool" : flag.type}>`)
    .join(" ");
  const optional = command.flags.some((flag) => !flag.required) ? "[flags]" : "";
  return ["durango", command.name, args, required, optional].filter(Boolean).join(" ");
}

function flagLine(flag: FlagSpec) {
  const value = flag.type === "boolean" ? "" : ` <${flag.type}>`;
  const label = `--${flag.name}${value}`;
  const notes: string[] = [];
  if (flag.required) notes.push("required");
  if (flag.repeatable) notes.push("repeatable");
  if (flag.choices) notes.push(flag.choices.join("|"));
  if (flag.default !== undefined) notes.push(`default ${flag.default}`);
  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  const gap = label.length >= 26 ? `${label} ` : label.padEnd(26);
  return `      ${gap}${flag.description}${suffix}`;
}

/** Human help. Pass a command name prefix to narrow it. */
export function renderHelp(filter?: string) {
  const query = (filter || "").trim();
  const commands = query
    ? COMMANDS.filter((command) => command.name === query || command.name.startsWith(`${query} `) || query.startsWith(`${command.name} `))
    : COMMANDS;

  if (commands.length === 0) {
    return `No help found for "${query}". Run: durango help\n`;
  }

  const lines: string[] = [];
  if (!query) {
    lines.push(`durango ${CLI_VERSION} — command-line client for the Durango API.`);
    lines.push("");
    lines.push("Usage:");
    lines.push("  durango <command> [args] [flags]");
    lines.push("");
    lines.push("Global flags:");
    for (const flag of GLOBAL_FLAGS) lines.push(flagLine(flag).slice(2));
    lines.push("");
  }

  let group = "";
  for (const command of commands) {
    if (command.group !== group) {
      group = command.group;
      lines.push(`${group}:`);
    }
    lines.push(`  ${usageLine(command)}`);
    lines.push(`      ${command.summary}`);
    for (const flag of command.flags) lines.push(flagLine(flag));
    for (const example of command.examples) lines.push(`      e.g. ${example}`);
    lines.push("");
  }

  if (!query) {
    lines.push("Environment:");
    const envWidth = Math.max(...ENVIRONMENT.map((entry) => entry.name.length)) + 2;
    for (const entry of ENVIRONMENT) lines.push(`  ${entry.name.padEnd(envWidth)}${entry.description}`);
    lines.push("");
    lines.push("Exit codes:");
    for (const entry of EXIT_CODES) lines.push(`  ${String(entry.code).padEnd(18)}${entry.meaning}`);
    lines.push("");
    lines.push("Agents: run `durango help --json` for a machine-readable command schema, and see AGENTS.md.");
  }

  return `${lines.join("\n")}\n`;
}
