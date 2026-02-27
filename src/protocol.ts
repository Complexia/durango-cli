export type DurangoErrorCode =
  | "MACHINE_OFFLINE"
  | "CODEX_UNAUTHENTICATED"
  | "PROJECT_NOT_FOUND"
  | "DISPATCH_TIMEOUT"
  | "APP_SERVER_ERROR"
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR";

export type ErrorEnvelope = {
  code: DurangoErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type MachineSession = {
  machineId: string;
  userId: string;
  hostname: string;
  displayName?: string;
  platform: NodeJS.Platform | string;
  arch: string;
  osVersion?: string;
  cliVersion: string;
  codexVersion?: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  online: boolean;
};

export type ProjectRef = {
  id: string;
  userId: string;
  machineId: string;
  absolutePath: string;
  name: string;
  gitBranch?: string;
  gitRemoteUrl?: string;
  createdAt: number;
};

export type ThreadRef = {
  id: string;
  userId: string;
  machineId: string;
  projectId: string;
  codexThreadId: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: number;
  updatedAt: number;
};

export type RunState = {
  runId: string;
  threadId: string;
  machineId: string;
  status: "queued" | "dispatched" | "running" | "completed" | "failed" | "interrupted";
  createdAt: number;
  updatedAt: number;
  error?: ErrorEnvelope;
};

export type DurangoThreadItem =
  | {
      type: "userMessage";
      id: string;
      turnId: string;
      text: string;
      timestamp: number;
    }
  | {
      type: "agentMessage";
      id: string;
      turnId: string;
      text: string;
      timestamp: number;
    }
  | {
      type: "reasoning";
      id: string;
      turnId: string;
      summary: string[];
      timestamp: number;
    }
  | {
      type: "commandExecution";
      id: string;
      turnId: string;
      command: string;
      cwd: string;
      status: "running" | "completed" | "failed";
      output?: string;
      exitCode?: number;
      timestamp: number;
    }
  | {
      type: "fileChange";
      id: string;
      turnId: string;
      path: string;
      patch: string;
      timestamp: number;
    }
  | {
      type: "plan";
      id: string;
      turnId: string;
      text: string;
      timestamp: number;
    };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type DispatchAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
  kind: "image" | "file";
};

export type DispatchAction =
  | {
      type: "thread.start";
      requestId: string;
      userId: string;
      machineId: string;
      projectId: string;
      cwd: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      attachments?: DispatchAttachment[];
      approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      prompt: string;
    }
  | {
      type: "thread.hydrate";
      requestId: string;
      userId: string;
      machineId: string;
      threadId: string;
      codexThreadId: string;
    }
  | {
      type: "turn.start";
      requestId: string;
      userId: string;
      machineId: string;
      threadId: string;
      codexThreadId: string;
      cwd?: string;
      prompt: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      attachments?: DispatchAttachment[];
      approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    }
  | {
      type: "model.list";
      requestId: string;
      userId: string;
      machineId: string;
    }
  | {
      type: "turn.interrupt";
      requestId: string;
      userId: string;
      machineId: string;
      threadId: string;
      codexThreadId: string;
    };

export type RelayClientMessage =
  | {
      type: "machine.hello";
      token: string;
      machine: Omit<MachineSession, "connectedAt" | "lastHeartbeatAt" | "online">;
    }
  | {
      type: "machine.heartbeat";
      machineId: string;
      timestamp: number;
    }
  | {
      type: "dispatch.ack";
      requestId: string;
      machineId: string;
      status: "accepted" | "running" | "completed" | "failed";
      error?: ErrorEnvelope;
      payload?: Record<string, unknown>;
    }
  | {
      type: "event.upsert";
      requestId: string;
      machineId: string;
      threadId: string;
      runId?: string;
      item: DurangoThreadItem;
    }
  | {
      type: "thread.update";
      machineId: string;
      threadId: string;
      title: string;
    }
  | {
      type: "thread.upsert";
      machineId: string;
      thread: {
        id: string;
        projectId: string;
        codexThreadId: string;
        title: string;
        status: ThreadRef["status"];
        createdAt: number;
        updatedAt: number;
      };
    };

export type RelayServerMessage =
  | {
      type: "session.ready";
      machineId: string;
      userId: string;
      heartbeatIntervalMs: number;
    }
  | {
      type: "dispatch.request";
      action: DispatchAction;
    }
  | {
      type: "session.error";
      error: ErrorEnvelope;
      recoverable: boolean;
    };

export const isRecoverableDurangoError = (code: DurangoErrorCode): boolean => {
  return ["MACHINE_OFFLINE", "DISPATCH_TIMEOUT", "APP_SERVER_ERROR"].includes(code);
};
