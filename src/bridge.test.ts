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

  it("maps structured review results into reviewResult items", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      mapReviewResult: (input: {
        turnId: string;
        timestamp?: number;
        reviewOutput?: unknown;
      }) => Record<string, unknown> | null;
    };

    const item = bridge.mapReviewResult({
      turnId: "turn-review",
      timestamp: 123,
      reviewOutput: {
        overall_explanation: "Found one issue.",
        overall_correctness: "incorrect",
        overall_confidence_score: 0.82,
        findings: [
          {
            title: "Missing null check",
            body: "The code dereferences a nullable value.",
            code_location: {
              absolute_file_path: "/tmp/project/src/foo.ts",
              line_range: { start: 12, end: 14 }
            },
            confidence_score: 0.91,
            priority: 1
          }
        ]
      }
    });

    expect(item).toEqual({
      type: "reviewResult",
      id: expect.any(String),
      turnId: "turn-review",
      summary: "Found one issue.",
      overallCorrectness: "incorrect",
      overallConfidenceScore: 0.82,
      findings: [
        {
          title: "Missing null check",
          body: "The code dereferences a nullable value.",
          codeLocation: {
            absoluteFilePath: "/tmp/project/src/foo.ts",
            lineRange: { start: 12, end: 14 }
          },
          confidenceScore: 0.91,
          priority: 1
        }
      ],
      timestamp: 123
    });
  });

  it("emits a completion lifecycle event for ordinary turn completions", () => {
    const send = vi.fn();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      forwardCodexNotification: (method: string, params: unknown) => void;
      send: typeof send;
      threadBindings: Map<string, string>;
    };

    bridge.send = send;
    bridge.threadBindings.set("thr_123", "codex:thr_123");

    bridge.forwardCodexNotification("turn/completed", {
      threadId: "thr_123",
      turnId: "turn_123",
      status: "completed",
      reviewOutput: {
        overall_explanation: "This should not render as a review on a normal thread."
      }
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "event.upsert",
      requestId: "turn_123",
      machineId: testConfig.machineId,
      threadId: "codex:thr_123",
      item: {
        type: "plan",
        id: expect.any(String),
        turnId: "turn_123",
        text: JSON.stringify({
          method: "turn/completed",
          params: {
            status: "completed"
          }
        }),
        timestamp: expect.any(Number)
      }
    });
  });

  it("emits review results only for known detached review threads", () => {
    const send = vi.fn();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      forwardCodexNotification: (method: string, params: unknown) => void;
      send: typeof send;
      threadBindings: Map<string, string>;
      reviewThreadIds: Set<string>;
    };

    bridge.send = send;
    bridge.threadBindings.set("review_123", "codex:review_123");
    bridge.reviewThreadIds.add("review_123");

    bridge.forwardCodexNotification("turn/completed", {
      threadId: "review_123",
      turnId: "turn_review_123",
      status: "completed",
      reviewOutput: {
        overall_explanation: "Found one issue."
      }
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, {
      type: "event.upsert",
      requestId: "turn_review_123",
      machineId: testConfig.machineId,
      threadId: "codex:review_123",
      item: {
        type: "plan",
        id: expect.any(String),
        turnId: "turn_review_123",
        text: JSON.stringify({
          method: "turn/completed",
          params: {
            status: "completed"
          }
        }),
        timestamp: expect.any(Number)
      }
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "event.upsert",
      requestId: "turn_review_123",
      machineId: testConfig.machineId,
      threadId: "codex:review_123",
      item: {
        type: "reviewResult",
        id: expect.any(String),
        turnId: "turn_review_123",
        summary: "Found one issue.",
        overallCorrectness: undefined,
        overallConfidenceScore: undefined,
        findings: [],
        timestamp: expect.any(Number)
      }
    });
  });

  it("prefers the active turn id when completion notifications carry a different turn id", () => {
    const send = vi.fn();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      forwardCodexNotification: (method: string, params: unknown) => void;
      send: typeof send;
      threadBindings: Map<string, string>;
      activeTurnIds: Map<string, string>;
    };

    bridge.send = send;
    bridge.threadBindings.set("thr_456", "codex:thr_456");
    bridge.activeTurnIds.set("thr_456", "turn_live_456");

    bridge.forwardCodexNotification("turn/completed", {
      threadId: "thr_456",
      turnId: "turn_wrong_456",
      status: "completed"
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "event.upsert",
      requestId: "turn_live_456",
      machineId: testConfig.machineId,
      threadId: "codex:thr_456",
      item: {
        type: "plan",
        id: "turn-completed:turn_live_456",
        turnId: "turn_live_456",
        text: JSON.stringify({
          method: "turn/completed",
          params: {
            status: "completed"
          }
        }),
        timestamp: expect.any(Number)
      }
    });
  });

  it("uses the dispatch request id for live turn events until completion", () => {
    const send = vi.fn();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      forwardCodexNotification: (method: string, params: unknown) => void;
      send: typeof send;
      threadBindings: Map<string, string>;
      activeDispatchRequestIds: Map<string, string>;
      activeTurnIds: Map<string, string>;
    };

    bridge.send = send;
    bridge.threadBindings.set("thr_live", "codex:thr_live");
    bridge.activeDispatchRequestIds.set("thr_live", "dispatch_live");
    bridge.activeTurnIds.set("thr_live", "turn_live");

    bridge.forwardCodexNotification("turn/completed", {
      threadId: "thr_live",
      turnId: "turn_live",
      status: "completed"
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event.upsert",
        requestId: "dispatch_live",
        threadId: "codex:thr_live"
      })
    );
  });

  it("merges assistant deltas into a live streamed message", () => {
    const send = vi.fn();
    const bridge = new DurangoBridge(testConfig) as unknown as {
      forwardCodexNotification: (method: string, params: unknown) => void;
      send: typeof send;
      threadBindings: Map<string, string>;
      activeDispatchRequestIds: Map<string, string>;
    };

    bridge.send = send;
    bridge.threadBindings.set("thr_delta", "codex:thr_delta");
    bridge.activeDispatchRequestIds.set("thr_delta", "dispatch_delta");

    bridge.forwardCodexNotification("item/delta", {
      threadId: "thr_delta",
      turnId: "turn_delta",
      item: {
        id: "assistant-delta",
        type: "assistant_message",
        content: {
          delta: "Hel"
        }
      }
    });
    bridge.forwardCodexNotification("item/delta", {
      threadId: "thr_delta",
      turnId: "turn_delta",
      item: {
        id: "assistant-delta",
        type: "assistant_message",
        content: {
          delta: "lo"
        }
      }
    });

    expect(send).toHaveBeenNthCalledWith(1, {
      type: "event.upsert",
      requestId: "dispatch_delta",
      machineId: testConfig.machineId,
      threadId: "codex:thr_delta",
      item: {
        type: "agentMessage",
        id: "assistant-delta",
        turnId: "turn_delta",
        text: "Hel",
        timestamp: expect.any(Number)
      }
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "event.upsert",
      requestId: "dispatch_delta",
      machineId: testConfig.machineId,
      threadId: "codex:thr_delta",
      item: {
        type: "agentMessage",
        id: "assistant-delta",
        turnId: "turn_delta",
        text: "Hello",
        timestamp: expect.any(Number)
      }
    });
  });

  it("resolves pending turn-start ack from the first streamed notification", async () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      ack: ReturnType<typeof vi.fn>;
      forwardCodexNotification: (method: string, params: unknown) => void;
      threadBindings: Map<string, string>;
      pendingTurnStartAcks: Map<
        string,
        {
          action: Record<string, unknown> & {
            type: "turn.start";
            requestId: string;
            machineId: string;
            threadId: string;
            codexThreadId: string;
          };
          codexThreadId: string;
          payload: Record<string, unknown>;
        }
      >;
    };

    bridge.ack = vi.fn().mockResolvedValue(undefined);
    bridge.threadBindings.set("thr_stream", "codex:thr_stream");
    bridge.pendingTurnStartAcks.set("thr_stream", {
      action: {
        type: "turn.start",
        requestId: "dispatch-turn-start",
        userId: "user-test",
        machineId: testConfig.machineId,
        threadId: "codex:thr_stream",
        codexThreadId: "thr_stream",
        projectId: "project-test",
        prompt: "hello"
      },
      codexThreadId: "thr_stream",
      payload: {
        state: "started"
      }
    });

    bridge.forwardCodexNotification("item/completed", {
      threadId: "thr_stream",
      turnId: "turn_stream_1",
      item: {
        id: "assistant-1",
        type: "assistant_message",
        content: "Hello"
      }
    });

    await Promise.resolve();

    expect(bridge.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.start",
        requestId: "dispatch-turn-start"
      }),
      "completed",
      {
        state: "started",
        turnId: "turn_stream_1"
      }
    );
  });

  it("does not resolve pending turn-start ack from synthetic auto-compact turns", async () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      ack: ReturnType<typeof vi.fn>;
      forwardCodexNotification: (method: string, params: unknown) => void;
      threadBindings: Map<string, string>;
      pendingTurnStartAcks: Map<
        string,
        {
          action: Record<string, unknown> & {
            type: "turn.start";
            requestId: string;
            machineId: string;
            threadId: string;
            codexThreadId: string;
          };
          codexThreadId: string;
          payload: Record<string, unknown>;
        }
      >;
    };

    bridge.ack = vi.fn().mockResolvedValue(undefined);
    bridge.threadBindings.set("thr_stream", "codex:thr_stream");
    bridge.pendingTurnStartAcks.set("thr_stream", {
      action: {
        type: "turn.start",
        requestId: "dispatch-turn-start",
        userId: "user-test",
        machineId: testConfig.machineId,
        threadId: "codex:thr_stream",
        codexThreadId: "thr_stream",
        projectId: "project-test",
        prompt: "hello"
      },
      codexThreadId: "thr_stream",
      payload: {
        state: "started"
      }
    });

    bridge.forwardCodexNotification("item/completed", {
      threadId: "thr_stream",
      turnId: "auto-compact-0",
      item: {
        id: "system-1",
        type: "message",
        role: "developer",
        content: "bootstrap"
      }
    });

    await Promise.resolve();

    expect(bridge.ack).not.toHaveBeenCalled();
    expect(bridge.pendingTurnStartAcks.has("thr_stream")).toBe(true);
  });

  it("ignores review-mode items on normal threads", () => {
    const bridge = new DurangoBridge(testConfig) as unknown as {
      mapCodexItem: (
        item: Record<string, unknown>,
        turnId: string,
        timestamp?: number,
        options?: { allowReviewItems?: boolean }
      ) => Array<Record<string, unknown>>;
    };

    expect(
      bridge.mapCodexItem(
        {
          id: "review-exit-1",
          type: "exited_review_mode",
          text: "Code review completed.",
          review: {
            overall_explanation: "Should not show up on a normal chat run."
          }
        },
        "turn-normal-1",
        123,
        { allowReviewItems: false }
      )
    ).toEqual([]);
  });

  it("schedules a reconnect after a failed relay connection attempt", async () => {
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

    const scheduledCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler) => {
        if (typeof handler === "function") {
          scheduledCallbacks.push(handler as () => void);
        }
        return 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bridge.ensureRelayConnection();
    expect(connectRelay).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Failed to connect to relay: offline. Retrying in 1s.");
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    scheduledCallbacks[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectRelay).toHaveBeenCalledTimes(2);
    expect(bridge.reconnectAttempt).toBe(1);
  });
});
