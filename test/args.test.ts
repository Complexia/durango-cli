import { describe, expect, test } from "bun:test";

import {
  optionBoolean,
  optionChoice,
  optionNumber,
  optionString,
  optionStrings,
  optionalNumber,
  parseArgs,
  requireOption,
} from "../src/lib/args.js";
import { CliError } from "../src/lib/errors.js";
import { flagTable } from "../src/lib/help.js";

describe("parseArgs", () => {
  test("collects positionals in order", () => {
    const { positionals, options } = parseArgs(["video", "edits", "status", "edit_1"]);
    expect(positionals).toEqual(["video", "edits", "status", "edit_1"]);
    expect(options).toEqual({});
  });

  test("parses --flag value and --flag=value", () => {
    const { options } = parseArgs(["--prompt", "a highlight reel", "--aspect-ratio=9:16"]);
    expect(options.prompt).toBe("a highlight reel");
    expect(options["aspect-ratio"]).toBe("9:16");
  });

  test("treats a trailing flag as boolean true", () => {
    const { options } = parseArgs(["video", "list", "--json"]);
    expect(options.json).toBe(true);
  });

  test("parses --no-<flag> as boolean false", () => {
    const { options } = parseArgs(["--no-wait"]);
    expect(options.wait).toBe(false);
    expect(optionBoolean(options, "wait", true)).toBe(false);
  });

  test("collects repeated flags into an array", () => {
    const { options } = parseArgs(["--source", "up_1", "--source", "up_2", "--source", "up_3"]);
    expect(options.source).toEqual(["up_1", "up_2", "up_3"]);
    expect(optionStrings(options, "source")).toEqual(["up_1", "up_2", "up_3"]);
  });

  test("keeps values containing = intact", () => {
    const { options } = parseArgs(["--url=https://example.com/v.m3u8?a=1&b=2"]);
    expect(options.url).toBe("https://example.com/v.m3u8?a=1&b=2");
  });

  test("does not consume the next flag as a value", () => {
    const { options, positionals } = parseArgs(["video", "upload", "./a.mp4", "--json", "--name", "clip"]);
    expect(positionals).toEqual(["video", "upload", "./a.mp4"]);
    expect(options.json).toBe(true);
    expect(options.name).toBe("clip");
  });

  test("full video edit invocation", () => {
    const { positionals, options } = parseArgs([
      "video",
      "edit",
      "--source",
      "up_1",
      "--source-file",
      "./b.mp4",
      "--prompt",
      "45s highlights",
      "--aspect-ratio",
      "9:16",
      "--max-duration",
      "45",
      "--no-wait",
      "--out",
      "reel.mp4",
    ]);
    expect(positionals).toEqual(["video", "edit"]);
    expect(optionStrings(options, "source")).toEqual(["up_1"]);
    expect(optionStrings(options, "source-file")).toEqual(["./b.mp4"]);
    expect(optionString(options, "prompt")).toBe("45s highlights");
    expect(optionNumber(options, "max-duration", 0)).toBe(45);
    expect(optionBoolean(options, "wait", true)).toBe(false);
  });
});

describe("schema-aware parsing", () => {
  const strict = (argv: string[]) => parseArgs(argv, flagTable(parseArgs(argv).positionals), { strict: true });

  test("declared booleans never swallow the following positional", () => {
    const { positionals, options } = strict(["video", "upload", "--json", "./a.mp4"]);
    expect(positionals).toEqual(["video", "upload", "./a.mp4"]);
    expect(options.json).toBe(true);
  });

  test("a declared value flag with no value is a usage error", () => {
    expect(() => strict(["download", "vid_1", "--out", "--json"])).toThrow("--out requires a value.");
    expect(() => strict(["video", "upload", "./a.mp4", "--name"])).toThrow("--name requires a value.");
  });

  test("declared choices are enforced for every command that declares them", () => {
    expect(() => strict(["download", "x", "--type", "vidoe", "--out", "a.mp4"]))
      .toThrow("--type must be one of: image, video.");
    expect(() => strict(["models", "list", "--type", "bogus"]))
      .toThrow("--type must be one of: chat, image, video.");
    expect(() => strict(["image", "generate", "--response-format", "jpeg"]))
      .toThrow("--response-format must be one of: url, b64_json.");
    expect(strict(["video", "edit", "--aspect-ratio", "9:16"]).options["aspect-ratio"]).toBe("9:16");
  });

  test("--no- is rejected for flags that take a value", () => {
    expect(() => strict(["video", "edit", "--no-prompt"])).toThrow("--prompt takes a value");
    expect(strict(["video", "edit", "--no-wait"]).options.wait).toBe(false);
  });

  test("undeclared flags keep the permissive behaviour", () => {
    const { options } = strict(["credits", "--experimental", "on"]);
    expect(options.experimental).toBe("on");
  });

  test("declared booleans accept an explicit true/false value token", () => {
    expect(strict(["video", "generate", "--wait", "false"]).options.wait).toBe(false);
    expect(strict(["video", "generate", "--wait", "true"]).options.wait).toBe(true);
    expect(strict(["video", "generate", "--audio", "false"]).options.audio).toBe(false);
    expect(strict(["image", "generate", "--private", "false"]).options.private).toBe(false);
    expect(strict(["video", "generate", "--wait=false"]).options.wait).toBe(false);
    expect(optionBoolean(strict(["video", "generate", "--wait", "false"]).options, "wait", true)).toBe(false);
  });

  test("the false value is consumed, not left as a positional", () => {
    const { positionals } = strict(["video", "generate", "--wait", "false", "--prompt", "p"]);
    expect(positionals).toEqual(["video", "generate"]);
  });

  test("a boolean still does not swallow anything other than true/false", () => {
    const { positionals, options } = strict(["video", "upload", "--json", "./a.mp4"]);
    expect(positionals).toEqual(["video", "upload", "./a.mp4"]);
    expect(options.json).toBe(true);
    expect(strict(["video", "generate", "--no-wait"]).options.wait).toBe(false);
  });

  test("a declared boolean rejects a non-boolean inline value", () => {
    expect(() => strict(["video", "generate", "--wait=maybe"])).toThrow("--wait must be true or false.");
  });

  test("declared number flags are validated before anything runs", () => {
    expect(() => strict(["video", "edit", "--source", "up_1", "--prompt", "p", "--max-duration", "abc"]))
      .toThrow("--max-duration must be a number.");
    expect(() => strict(["video", "list", "--limit", ""])).toThrow("--limit must be a number.");
    expect(() => strict(["video", "generate", "--poll-interval", "1x"])).toThrow("--poll-interval must be a number.");
    expect(strict(["video", "edit", "--max-duration", "45"]).options["max-duration"]).toBe("45");
    expect(strict(["video", "generate", "--duration", "-2.5"]).options.duration).toBe("-2.5");
  });

  test("-- ends the flags: everything after it is positional", () => {
    const { positionals, options } = parseArgs(["video", "upload", "--json", "--", "--weird.mp4", "--out"]);
    expect(positionals).toEqual(["video", "upload", "--weird.mp4", "--out"]);
    expect(options).toEqual({ json: true });
    expect(options[""]).toBeUndefined();
  });

  test("-- is honoured by the schema-aware parse too", () => {
    const { positionals, options } = strict(["video", "upload", "--", "--a.mp4"]);
    expect(positionals).toEqual(["video", "upload", "--a.mp4"]);
    expect(options).toEqual({});
  });
});

describe("option accessors", () => {
  test("optionString returns the last repeated value", () => {
    const { options } = parseArgs(["--out", "a.mp4", "--out", "b.mp4"]);
    expect(optionString(options, "out")).toBe("b.mp4");
  });

  test("optionBoolean returns the last repeated value", () => {
    const { options } = parseArgs(["--json", "--json"]);
    expect(optionBoolean(options, "json", false)).toBe(true);

    const negated = parseArgs(["--wait", "--no-wait"]).options;
    expect(optionBoolean(negated, "wait", true)).toBe(false);

    const mixed = parseArgs(["--private", "false", "--private", "true"]).options;
    expect(optionBoolean(mixed, "private", false)).toBe(true);
  });

  test("optionStrings normalizes single values", () => {
    const { options } = parseArgs(["--source", "up_1"]);
    expect(optionStrings(options, "source")).toEqual(["up_1"]);
    expect(optionStrings(options, "missing")).toEqual([]);
  });

  test("optionNumber falls back and validates", () => {
    const { options } = parseArgs(["--poll-interval", "abc"]);
    expect(optionNumber({}, "poll-interval", 12)).toBe(12);
    expect(() => optionNumber(options, "poll-interval", 12)).toThrow(CliError);
  });

  test("optionalNumber is undefined when absent", () => {
    expect(optionalNumber({}, "max-duration")).toBeUndefined();
    expect(optionalNumber(parseArgs(["--max-duration", "30"]).options, "max-duration")).toBe(30);
  });

  test("requireOption throws a usage error", () => {
    expect(() => requireOption({}, "model")).toThrow("Missing --model.");
    try {
      requireOption({}, "model");
    } catch (error) {
      expect((error as CliError).exitCode).toBe(1);
    }
  });

  test("optionChoice validates against the allowed set", () => {
    const choices = ["9:16", "16:9", "1:1", "original"] as const;
    expect(optionChoice({}, "aspect-ratio", choices, "original")).toBe("original");
    expect(optionChoice({ "aspect-ratio": "9:16" }, "aspect-ratio", choices)).toBe("9:16");
    expect(() => optionChoice({ "aspect-ratio": "4:3" }, "aspect-ratio", choices)).toThrow(CliError);
  });
});
