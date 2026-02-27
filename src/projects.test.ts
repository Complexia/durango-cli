import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpPrefix = path.join(os.tmpdir(), "durango-cli-projects-");

describe("project persistence", () => {
  let testConfigDir = "";
  let testProjectDir = "";

  beforeEach(async () => {
    testConfigDir = await mkdtemp(tmpPrefix);
    testProjectDir = await mkdtemp(tmpPrefix);
    process.env.DURANGO_CONFIG_DIR = testConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DURANGO_CONFIG_DIR;
    vi.resetModules();
  });

  it("writes local manifest and global registry during init persistence", async () => {
    const { saveProjectRegistration } = await import("./projects.js");
    const saved = await saveProjectRegistration({
      absolutePath: testProjectDir,
      machineId: "machine-a",
      gitBranch: "main",
      gitRemoteUrl: "git@github.com:example/repo.git"
    });

    const manifestPath = path.join(testProjectDir, ".durango", "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      project: { id: string; machineId: string };
    };
    expect(manifest.project.id).toBe(saved.id);
    expect(manifest.project.machineId).toBe("machine-a");

    const registryPath = path.join(testConfigDir, "projects.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as string[];
    expect(registry).toContain(manifestPath);
  });

  it("preserves project identity when saved multiple times", async () => {
    const { saveProjectRegistration } = await import("./projects.js");
    const first = await saveProjectRegistration({
      absolutePath: testProjectDir,
      machineId: "machine-a",
      gitBranch: "main"
    });
    const second = await saveProjectRegistration({
      absolutePath: testProjectDir,
      machineId: "machine-a",
      gitBranch: "feature/new-work"
    });

    expect(second.id).toBe(first.id);
    expect(second.gitBranch).toBe("feature/new-work");
  });

  it("loads valid projects and compacts stale registry entries", async () => {
    const { loadProjectsForMachine, saveProjectRegistration } = await import("./projects.js");
    const saved = await saveProjectRegistration({
      absolutePath: testProjectDir,
      machineId: "machine-a"
    });

    const missingManifestPath = path.join(testConfigDir, "missing", "project.json");
    const registryPath = path.join(testConfigDir, "projects.json");
    await writeFile(
      registryPath,
      JSON.stringify([path.join(testProjectDir, ".durango", "project.json"), missingManifestPath], null, 2),
      "utf8"
    );

    const loaded = await loadProjectsForMachine("machine-b");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(saved.id);
    expect(loaded[0]?.machineId).toBe("machine-b");

    const compactedRegistry = JSON.parse(await readFile(registryPath, "utf8")) as string[];
    expect(compactedRegistry).toEqual([path.join(testProjectDir, ".durango", "project.json")]);
  });
});
