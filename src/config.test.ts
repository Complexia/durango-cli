import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpPrefix = path.join(os.tmpdir(), "durango-cli-config-");

describe("machine identity persistence", () => {
  let testConfigDir = "";

  beforeEach(async () => {
    testConfigDir = await mkdtemp(tmpPrefix);
    process.env.DURANGO_CONFIG_DIR = testConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DURANGO_CONFIG_DIR;
    vi.resetModules();
  });

  it("persists a generated machine id across reads", async () => {
    const { ensureMachineId, readMachineId } = await import("./config.js");

    const first = await ensureMachineId();
    const second = await ensureMachineId();
    const stored = await readMachineId();

    expect(first).toBe(second);
    expect(stored).toBe(first);
  });

  it("seeds the persisted machine id from the existing config machine id", async () => {
    const { configPath, ensureMachineId } = await import("./config.js");

    const seeded = await ensureMachineId("machine-from-config");
    const raw = JSON.parse(await readFile(path.join(testConfigDir, "machine.json"), "utf8")) as {
      machineId: string;
    };

    expect(seeded).toBe("machine-from-config");
    expect(raw.machineId).toBe("machine-from-config");
    expect(configPath.startsWith(testConfigDir)).toBe(true);
  });
});
