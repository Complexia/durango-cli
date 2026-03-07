import { afterEach, describe, expect, it, vi } from "vitest";
import { DurangoBridge } from "./bridge.js";
import type { CliConfig } from "./config.js";
import type { ProjectRegistration } from "./projects.js";

const testConfig: CliConfig = {
  machineId: "machine-test",
  userId: "user-test",
  token: "token-test",
  relayUrl: "http://localhost:8788",
  webUrl: "http://localhost:3000"
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DurangoBridge history hydration parsing", () => {
  it("extracts turns from nested turnsPage payloads", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      extractTurnsFromThreadReadResponse: (response: unknown) => Array<Record<string, unknown>>;
    };

    const turns = bridge.extractTurnsFromThreadReadResponse({
      thread: {
        turnsPage: {
          data: [{ id: "turn-1", items: [{ type: "plan", text: "ok" }] }]
        }
      }
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe("turn-1");
    expect(Array.isArray(turns[0]?.items)).toBe(true);
  });

  it("builds a synthetic turn when only items are returned", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      extractTurnsFromThreadReadResponse: (response: unknown) => Array<Record<string, unknown>>;
    };

    const turns = bridge.extractTurnsFromThreadReadResponse({
      thread: {
        id: "thread-1",
        items: [{ type: "agentMessage", text: "hello" }]
      }
    });

    expect(turns).toHaveLength(1);
    expect(Array.isArray(turns[0]?.items)).toBe(true);
  });

  it("infers completed lifecycle for hydrated turns with no explicit status", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      inferHydratedTurnLifecycleStatus: (
        turn: Record<string, unknown>,
        importedTurnItemCount: number,
        hasRunningActivity: boolean
      ) => "completed" | "failed" | "interrupted" | null;
    };

    const status = bridge.inferHydratedTurnLifecycleStatus({ id: "turn-1" }, 2, false);
    expect(status).toBe("completed");
  });

  it("keeps hydrated turns open when status is running", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      inferHydratedTurnLifecycleStatus: (
        turn: Record<string, unknown>,
        importedTurnItemCount: number,
        hasRunningActivity: boolean
      ) => "completed" | "failed" | "interrupted" | null;
    };

    const status = bridge.inferHydratedTurnLifecycleStatus({ id: "turn-1", status: "running" }, 2, true);
    expect(status).toBeNull();
  });

  it("maps interrupted and failed hydrated turn statuses", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      inferHydratedTurnLifecycleStatus: (
        turn: Record<string, unknown>,
        importedTurnItemCount: number,
        hasRunningActivity: boolean
      ) => "completed" | "failed" | "interrupted" | null;
    };

    expect(bridge.inferHydratedTurnLifecycleStatus({ id: "turn-1", status: "cancelled" }, 1, false)).toBe(
      "interrupted"
    );
    expect(bridge.inferHydratedTurnLifecycleStatus({ id: "turn-2", status: "failed" }, 1, false)).toBe("failed");
  });

  it("does not synthesize completion when hydrated items indicate running activity", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      inferHydratedTurnLifecycleStatus: (
        turn: Record<string, unknown>,
        importedTurnItemCount: number,
        hasRunningActivity: boolean
      ) => "completed" | "failed" | "interrupted" | null;
    };

    const status = bridge.inferHydratedTurnLifecycleStatus({ id: "turn-3" }, 2, true);
    expect(status).toBeNull();
  });

  it("uses the same fingerprint for the same project set regardless of order", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      buildProjectSyncFingerprint: (projects: ProjectRegistration[]) => string;
    };

    const a: ProjectRegistration = {
      id: "project-a",
      machineId: "machine-test",
      absolutePath: "/tmp/alpha",
      name: "alpha",
      gitBranch: "main"
    };
    const b: ProjectRegistration = {
      id: "project-b",
      machineId: "machine-test",
      absolutePath: "/tmp/beta",
      name: "beta",
      gitRemoteUrl: "git@example.com:beta.git"
    };

    expect(bridge.buildProjectSyncFingerprint([a, b])).toBe(bridge.buildProjectSyncFingerprint([b, a]));
  });

  it("changes the project fingerprint when a new init registration appears", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      buildProjectSyncFingerprint: (projects: ProjectRegistration[]) => string;
    };

    const initial: ProjectRegistration[] = [
      {
        id: "project-a",
        machineId: "machine-test",
        absolutePath: "/tmp/alpha",
        name: "alpha"
      }
    ];
    const updated: ProjectRegistration[] = [
      ...initial,
      {
        id: "project-b",
        machineId: "machine-test",
        absolutePath: "/tmp/beta",
        name: "beta"
      }
    ];

    expect(bridge.buildProjectSyncFingerprint(updated)).not.toBe(bridge.buildProjectSyncFingerprint(initial));
  });

  it("schedules a reconnect after a failed relay connection attempt", async () => {
    vi.useFakeTimers();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      connectRelay: () => Promise<void>;
      ensureRelayConnection: () => Promise<void>;
      reconnectAttempt: number;
    };

    const connectRelay = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    bridge.connectRelay = connectRelay;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bridge.ensureRelayConnection();
    expect(connectRelay).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Failed to connect to relay: offline. Retrying in 1s.");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectRelay).toHaveBeenCalledTimes(2);
    expect(bridge.reconnectAttempt).toBe(1);
  });
});
