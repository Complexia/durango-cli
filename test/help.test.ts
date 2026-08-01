import { describe, expect, test } from "bun:test";

import { CLI_VERSION, COMMANDS, ENVIRONMENT, findCommand, flagTable, GLOBAL_FLAGS, helpSchema, renderHelp } from "../src/lib/help.js";

const REQUIRED_COMMANDS = [
  "help",
  "version",
  "login",
  "config set",
  "whoami",
  "credits",
  "models list",
  "image generate",
  "video generate",
  "video status",
  "video list",
  "video upload",
  "video edit",
  "video edits status",
  "video edits list",
  "uploads list",
  "uploads get",
  "uploads delete",
  "download",
];

describe("help --json schema", () => {
  const schema = helpSchema();

  test("is a single serializable object with the expected top-level shape", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(schema.object).toBe("cli.schema");
    expect(schema.name).toBe("durango");
    expect(schema.version).toBe(CLI_VERSION);
    expect(CLI_VERSION).toBe("0.4.0");
    expect(schema.default_base_url).toBe("https://durango.sh");
    expect(Array.isArray(schema.commands)).toBe(true);
    expect(Array.isArray(schema.global_flags)).toBe(true);
    expect(Array.isArray(schema.environment)).toBe(true);
  });

  test("documents the --json contract and exit codes", () => {
    expect(schema.json_output.flag).toBe("--json");
    expect(schema.json_output.error_shape).toEqual({ error: { message: "string", code: "string" } });
    expect(schema.exit_codes.map((entry) => entry.code)).toEqual([0, 1, 2]);
  });

  test("exposes the global flags", () => {
    const names = GLOBAL_FLAGS.map((flag) => flag.name);
    expect(names).toContain("json");
    expect(names).toContain("base-url");
    expect(names).toContain("api-key");
  });

  test("covers every contract command exactly once", () => {
    const names = schema.commands.map((command) => command.name);
    for (const required of REQUIRED_COMMANDS) {
      expect(names).toContain(required);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("every command entry is fully described", () => {
    for (const command of COMMANDS) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.group.length).toBeGreaterThan(0);
      expect(command.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(command.args)).toBe(true);
      expect(Array.isArray(command.flags)).toBe(true);
      expect(command.examples.length).toBeGreaterThan(0);

      for (const arg of command.args) {
        expect(typeof arg.name).toBe("string");
        expect(typeof arg.required).toBe("boolean");
        expect(arg.description.length).toBeGreaterThan(0);
      }
      for (const flag of command.flags) {
        expect(["string", "number", "boolean"]).toContain(flag.type);
        expect(flag.description.length).toBeGreaterThan(0);
        expect(flag.name.startsWith("--")).toBe(false);
      }
      for (const example of command.examples) {
        expect(example.startsWith("durango ")).toBe(true);
      }
    }
  });

  test("video edit exposes the contract flags with contract defaults", () => {
    const edit = COMMANDS.find((command) => command.name === "video edit");
    expect(edit).toBeDefined();
    const flags = Object.fromEntries(edit!.flags.map((flag) => [flag.name, flag]));
    expect(flags.source.repeatable).toBe(true);
    expect(flags["source-file"].repeatable).toBe(true);
    expect(flags["aspect-ratio"].choices).toEqual(["9:16", "16:9", "1:1", "original"]);
    expect(flags["aspect-ratio"].default).toBe("original");
    expect(flags.resolution.choices).toEqual(["720p", "1080p", "original"]);
    expect(flags.resolution.default).toBe("original");
    expect(flags["max-duration"].type).toBe("number");
    expect(flags.wait.default).toBe(true);
    expect(flags.out).toBeDefined();
    expect(flags.model).toBeDefined();
    expect(flags["poll-interval"].type).toBe("number");
    expect(flags.timeout.type).toBe("number");
  });

  test("video generate keeps its legacy defaults", () => {
    const generate = COMMANDS.find((command) => command.name === "video generate");
    const flags = Object.fromEntries(generate!.flags.map((flag) => [flag.name, flag]));
    expect(flags["aspect-ratio"].default).toBe("16:9");
    expect(flags.resolution.default).toBe("720p");
    expect(flags.duration.default).toBe(5);
    expect(flags["poll-interval"].default).toBe(12);
    expect(flags.timeout.default).toBe(30);
    expect(flags["model-id"].repeatable).toBe(true);
  });
});

describe("schema lookup", () => {
  test("resolves the longest matching command name", () => {
    expect(findCommand(["video", "edits", "status", "edit_1"])?.name).toBe("video edits status");
    expect(findCommand(["video", "edit"])?.name).toBe("video edit");
    expect(findCommand(["video", "status", "run_1"])?.name).toBe("video status");
    expect(findCommand(["nope"])).toBeUndefined();
  });

  test("the flag table merges global flags with the command's own", () => {
    const table = flagTable(["video", "edit"]);
    expect(table.get("json")?.type).toBe("boolean");
    expect(table.get("source")?.repeatable).toBe(true);
    expect(table.get("aspect-ratio")?.choices).toEqual(["9:16", "16:9", "1:1", "original"]);
    expect(flagTable(["video", "generate"]).get("aspect-ratio")?.choices).toBeUndefined();
  });
});

describe("environment", () => {
  test("documents every variable the CLI reads", () => {
    const names = ENVIRONMENT.map((entry) => entry.name);
    expect(names).toEqual([
      "DURANGO_API_KEY",
      "DURANGO_BASE_URL",
      "XDG_CONFIG_HOME",
      "DURANGO_HTTP_TIMEOUT_MS",
      "DURANGO_DEBUG",
    ]);
  });
});

describe("human help", () => {
  const text = renderHelp();

  test("lists every command", () => {
    for (const command of COMMANDS) {
      expect(text).toContain(`durango ${command.name}`);
    }
  });

  test("documents globals, env, and exit codes", () => {
    expect(text).toContain("--json");
    expect(text).toContain("DURANGO_API_KEY");
    expect(text).toContain("DURANGO_BASE_URL");
    expect(text).toContain("Exit codes:");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("can be narrowed to one command", () => {
    const narrowed = renderHelp("video edit");
    expect(narrowed).toContain("durango video edit");
    expect(narrowed).not.toContain("durango image generate");
  });

  test("reports unknown help topics", () => {
    expect(renderHelp("nope")).toContain("No help found");
  });
});
