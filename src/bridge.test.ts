import { describe, expect, it } from "vitest";
import { DurangoBridge } from "./bridge.js";
import type { CliConfig } from "./config.js";

const testConfig: CliConfig = {
  machineId: "machine-test",
  userId: "user-test",
  token: "token-test",
  relayUrl: "http://localhost:8788",
  webUrl: "http://localhost:3000"
};

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
});
