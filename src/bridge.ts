import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import WebSocket from "ws";
import type { DispatchAction, DurangoThreadItem, RelayClientMessage, RelayServerMessage } from "./protocol.js";
import { CodexAppServerClient, type CodexTurnInputItem } from "./codex-adapter.js";
import type { CliConfig } from "./config.js";
import { listGitBranches, readGitMeta } from "./git.js";
import { postJson } from "./http.js";
import { loadProjectsForMachine, type ProjectRegistration } from "./projects.js";

const relayWsUrl = (relayUrl: string): string => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
};

type PendingRun = {
  requestId: string;
  threadId: string;
};

type PendingTurnStartAction = Extract<DispatchAction, { type: "thread.start" | "turn.start" }>;

type PendingTurnStartAck = {
  action: PendingTurnStartAction;
  codexThreadId: string;
  payload: Record<string, unknown>;
};

type DispatchAttachment = NonNullable<Extract<DispatchAction, { type: "turn.start" }>["attachments"]>[number];
const PROJECT_SYNC_INTERVAL_MS = 10_000;
const RELAY_RECONNECT_BASE_DELAY_MS = 1_000;
const RELAY_RECONNECT_MAX_DELAY_MS = 30_000;
const RELAY_LIVENESS_MIN_INTERVAL_MS = 15_000;

type ProjectSyncOutcome = {
  attempted: number;
  delivered: number;
  updated: number;
  failed: number;
};

export class DurangoBridge {
  private readonly codex = new CodexAppServerClient();
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private projectSyncTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRun>();
  private readonly threadBindings = new Map<string, string>();
  private readonly reviewThreadIds = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly pendingTurnStartAcks = new Map<string, PendingTurnStartAck>();
  private lastProjectSyncFingerprint: string | null = null;
  private reconnectAttempt = 0;
  private awaitingRelayPong = false;
  private stopRequested = false;
  private hasConnectedOnce = false;

  constructor(private readonly config: CliConfig) {}

  async start(): Promise<void> {
    this.stopRequested = false;
    this.codex.on("stderr", (chunk: string) => {
      for (const rawLine of chunk.split(/\r?\n/)) {
        const text = rawLine.trim();
        if (text.length === 0 || this.shouldSuppressCodexAppServerLine(text)) {
          continue;
        }
        console.error(`[codex-app-server] ${text}`);
      }
    });

    await this.codex.start();
    this.codex.on("notification", (notification) => {
      this.forwardCodexNotification(notification.method, notification.params);
    });

    const status = await this.codex.getAuthStatus().catch(() => null);
    if (!status) {
      console.warn("Could not validate Codex auth status. Ensure `codex login` has been completed.");
    }

    void this.ensureRelayConnection();
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await this.stop();
  }

  private shouldSuppressCodexAppServerLine(line: string): boolean {
    // Known benign Codex app-server noise from stale rollout rows in its state DB.
    // Normalize ANSI and whitespace so chunk formatting cannot bypass suppression.
    const normalized = line
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    return (
      normalized.includes("codex app-server (websockets)") ||
      normalized.includes("listening on: ws://") ||
      normalized.includes("note: binds localhost only") ||
      normalized.includes("websocket client connected from") ||
      normalized.includes("state db missing rollout path for thread") ||
      normalized.includes("find_thread_path_by_id_str_in_subdir") ||
      normalized.includes("state db record_discrepancy")
    );
  }

  private async ensureRelayConnection(): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const connectPromise = this.connectRelay()
      .catch((error) => {
        if (this.stopRequested) {
          return;
        }

        const message = error instanceof Error ? error.message : "unknown error";
        this.scheduleReconnect(`Failed to connect to relay: ${message}`);
      })
      .finally(() => {
        if (this.connectPromise === connectPromise) {
          this.connectPromise = null;
        }
      });

    this.connectPromise = connectPromise;
    return connectPromise;
  }

  private async connectRelay(): Promise<void> {
    const wsUrl = relayWsUrl(this.config.relayUrl);
    const socket = new WebSocket(wsUrl, {
      perMessageDeflate: false
    });
    this.ws = socket;

    socket.on("open", () => {
      if (this.ws !== socket || this.stopRequested) {
        return;
      }

      const hello: RelayClientMessage = {
        type: "machine.hello",
        token: this.config.token,
        machine: {
          machineId: this.config.machineId,
          userId: this.config.userId,
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          osVersion: os.release(),
          cliVersion: "0.1.2",
          codexVersion: process.env.CODEX_VERSION ?? "unknown"
        }
      };

      socket.send(JSON.stringify(hello));
    });

    socket.on("pong", () => {
      if (this.ws !== socket) {
        return;
      }

      this.awaitingRelayPong = false;
    });

    socket.on("message", async (data) => {
      if (this.ws !== socket) {
        return;
      }

      const message = JSON.parse(data.toString()) as RelayServerMessage;

      if (message.type === "session.ready") {
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();
        this.awaitingRelayPong = false;
        console.log("Connected.");
        this.hasConnectedOnce = true;
        this.startHeartbeat(message.heartbeatIntervalMs);
        this.startRelayLivenessProbe(message.heartbeatIntervalMs);
        await this.syncProjectsAndThreads({ force: true });
        this.startProjectSyncLoop();
        return;
      }

      if (message.type === "session.error") {
        console.error(`Relay session error: ${message.error.code} ${message.error.message}`);
        if (!message.recoverable) {
          await this.stop();
          process.exit(1);
        }
        socket.close();
        return;
      }

      if (message.type === "dispatch.request") {
        await this.handleDispatch(message.action);
      }
    });

    socket.on("close", () => {
      if (this.ws !== socket) {
        return;
      }

      this.ws = null;
      this.clearRelayLoopTimers();

      if (!this.stopRequested) {
        this.scheduleReconnect("Disconnected from relay");
      }
    });

    socket.on("error", (error) => {
      if (this.ws !== socket) {
        return;
      }

      console.error("Relay websocket error", error);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (err) => reject(err));
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearRelayLoopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.projectSyncTimer) {
      clearInterval(this.projectSyncTimer);
      this.projectSyncTimer = null;
    }

    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }

    this.awaitingRelayPong = false;
  }

  private nextReconnectDelayMs(): number {
    const delayMs = Math.min(
      RELAY_RECONNECT_MAX_DELAY_MS,
      RELAY_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt
    );
    this.reconnectAttempt += 1;
    return delayMs;
  }

  private formatReconnectDelay(delayMs: number): string {
    return delayMs >= 1_000 ? `${Math.round(delayMs / 1_000)}s` : `${delayMs}ms`;
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopRequested || this.reconnectTimer) {
      return;
    }

    const delayMs = this.nextReconnectDelayMs();
    console.warn(`${reason}. Retrying in ${this.formatReconnectDelay(delayMs)}.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureRelayConnection();
    }, delayMs);
  }

  private send(message: RelayClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: "machine.heartbeat",
        machineId: this.config.machineId,
        timestamp: Date.now()
      });
    }, intervalMs);
  }

  private startRelayLivenessProbe(intervalMs: number): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
    }

    this.awaitingRelayPong = false;
    this.livenessTimer = setInterval(() => {
      const socket = this.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (this.awaitingRelayPong) {
        console.warn("Relay websocket became unresponsive. Reconnecting.");
        socket.terminate();
        return;
      }

      this.awaitingRelayPong = true;
      try {
        socket.ping();
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`Failed to ping relay websocket: ${message}`);
        this.awaitingRelayPong = false;
        socket.terminate();
      }
    }, Math.max(RELAY_LIVENESS_MIN_INTERVAL_MS, intervalMs));
  }

  private startProjectSyncLoop(): void {
    if (this.projectSyncTimer) {
      clearInterval(this.projectSyncTimer);
    }

    this.projectSyncTimer = setInterval(() => {
      void this.syncProjectsAndThreads().catch((error) => {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`Failed to refresh local Durango projects: ${message}`);
      });
    }, PROJECT_SYNC_INTERVAL_MS);
  }

  private buildProjectSyncFingerprint(projects: ProjectRegistration[]): string {
    return [...projects]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((project) =>
        [
          project.id,
          project.machineId,
          this.normalizePath(project.absolutePath),
          project.name,
          project.gitBranch ?? "",
          project.gitRemoteUrl ?? ""
        ].join("|")
      )
      .join("\n");
  }

  private async syncProjectsAndThreads(options?: { force?: boolean }): Promise<ProjectRegistration[]> {
    const projects = await this.loadProjectsWithGitMeta();
    const nextFingerprint = this.buildProjectSyncFingerprint(projects);
    if (!options?.force && nextFingerprint === this.lastProjectSyncFingerprint) {
      return projects;
    }

    const syncedProjects = await this.syncProjects(projects);
    await this.syncThreads(syncedProjects);
    this.lastProjectSyncFingerprint = nextFingerprint;
    return syncedProjects;
  }

  private async loadProjectsWithGitMeta(): Promise<ProjectRegistration[]> {
    const projects = await loadProjectsForMachine(this.config.machineId);
    return Promise.all(
      projects.map(async (project) => {
        const git = await readGitMeta(project.absolutePath);
        return {
          ...project,
          gitBranch: git.branch ?? project.gitBranch,
          gitRemoteUrl: git.remoteUrl ?? project.gitRemoteUrl
        };
      })
    );
  }

  private async syncProjects(projects: ProjectRegistration[]): Promise<ProjectRegistration[]> {
    if (projects.length === 0) {
      return [];
    }

    const endpoint = `${this.config.relayUrl.replace(/\/$/, "")}/v1/projects/register`;
    const outcome: ProjectSyncOutcome = {
      attempted: projects.length,
      delivered: 0,
      updated: 0,
      failed: 0
    };

    for (const project of projects) {
      try {
        const result = await postJson<{ ok: boolean }>(endpoint, { project }, this.config.token);
        outcome.delivered += 1;
        if (result.ok) {
          outcome.updated += 1;
        }
      } catch (error) {
        outcome.failed += 1;
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`Failed to sync project ${project.absolutePath}: ${message}`);
      }
    }

    return projects;
  }

  private makeDurangoThreadId(codexThreadId: string): string {
    return `codex:${codexThreadId}`;
  }

  private normalizeTimestamp(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return Date.now();
    }

    // Codex thread/list timestamps are unix seconds in current app-server builds.
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }

  private titleFromPreview(preview: string | undefined): string {
    if (!preview) {
      return "Imported Codex thread";
    }

    const firstLine = preview
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return "Imported Codex thread";
    }

    return firstLine.replace(/\s+/g, " ").slice(0, 120);
  }

  private normalizePath(input: string): string {
    const resolved = path.resolve(input);
    if (resolved.length <= 1) {
      return resolved;
    }

    return resolved.replace(/[\\/]+$/, "");
  }

  private findProjectIdForCwd(projects: ProjectRegistration[], cwd: string): string | null {
    const normalizedCwd = this.normalizePath(cwd);
    let bestMatch: ProjectRegistration | null = null;
    let bestPathLength = -1;

    for (const project of projects) {
      const projectPath = this.normalizePath(project.absolutePath);
      const withinProject =
        normalizedCwd === projectPath || normalizedCwd.startsWith(`${projectPath}${path.sep}`);
      if (!withinProject) {
        continue;
      }

      if (projectPath.length > bestPathLength) {
        bestMatch = project;
        bestPathLength = projectPath.length;
      }
    }

    return bestMatch?.id ?? null;
  }

  private async syncThreads(projects: ProjectRegistration[]): Promise<void> {
    if (projects.length === 0) {
      return;
    }

    let appThreads: Awaited<ReturnType<CodexAppServerClient["listThreads"]>>;
    try {
      appThreads = await this.codex.listThreads({ limit: 50, maxPages: 10 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Failed to sync saved threads from codex app-server: ${message}`);
      return;
    }

    let synced = 0;
    for (const appThread of appThreads) {
      const codexThreadId = this.getString(appThread.id);
      const cwd = this.getString(appThread.cwd);
      if (!codexThreadId || !cwd) {
        continue;
      }

      const projectId = this.findProjectIdForCwd(projects, cwd);
      if (!projectId) {
        continue;
      }

      const durangoThreadId =
        this.threadBindings.get(codexThreadId) ?? this.makeDurangoThreadId(codexThreadId);
      this.threadBindings.set(codexThreadId, durangoThreadId);
      const createdAt = this.normalizeTimestamp(this.getNumber(appThread.createdAt) ?? undefined);
      const updatedAt = this.normalizeTimestamp(
        this.getNumber(appThread.updatedAt) ?? this.getNumber(appThread.createdAt) ?? undefined
      );

      this.send({
        type: "thread.upsert",
        machineId: this.config.machineId,
        thread: {
          id: durangoThreadId,
          projectId,
          codexThreadId,
          title: this.titleFromPreview(this.getString(appThread.preview) ?? undefined),
          status: "active",
          createdAt,
          updatedAt
        }
      });
      synced += 1;
    }

  }

  private async ack(action: DispatchAction, status: "accepted" | "running" | "completed" | "failed", payload?: Record<string, unknown>, error?: { code: string; message: string }): Promise<void> {
    this.send({
      type: "dispatch.ack",
      requestId: action.requestId,
      machineId: action.machineId,
      status,
      payload,
      error: error ? { code: error.code as never, message: error.message } : undefined
    });
  }

  private sanitizeAttachmentName(rawName: string): string {
    const baseName = path.basename(rawName || "attachment");
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized.length > 120 ? sanitized.slice(0, 120) : sanitized || "attachment";
  }

  private async materializeAttachmentInputs(args: {
    cwd?: string;
    requestId: string;
    attachments?: DispatchAttachment[];
  }): Promise<CodexTurnInputItem[]> {
    const attachments = args.attachments ?? [];
    if (attachments.length === 0) {
      return [];
    }

    const baseDir = args.cwd ? path.resolve(args.cwd) : os.tmpdir();
    const attachmentDir = path.join(baseDir, ".durango", "uploads", args.requestId);
    await mkdir(attachmentDir, { recursive: true });

    const inputs: CodexTurnInputItem[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const safeName = this.sanitizeAttachmentName(attachment.name);
      const fileName = `${String(index + 1).padStart(2, "0")}-${safeName}`;
      const absolutePath = path.join(attachmentDir, fileName);
      const buffer = Buffer.from(attachment.contentBase64, "base64");
      await writeFile(absolutePath, buffer);

      if (attachment.kind === "image") {
        inputs.push({ type: "localImage", path: absolutePath });
      } else {
        inputs.push({
          type: "mention",
          name: attachment.name,
          path: absolutePath
        });
      }
    }

    return inputs;
  }

  private async buildTurnInput(args: {
    prompt?: string;
    requestId: string;
    cwd?: string;
    attachments?: DispatchAttachment[];
  }): Promise<CodexTurnInputItem[]> {
    const prompt = args.prompt?.trim() ?? "";
    const input: CodexTurnInputItem[] = prompt
      ? [
          {
            type: "text",
            text: prompt
          }
        ]
      : [];

    const attachmentInputs = await this.materializeAttachmentInputs({
      cwd: args.cwd,
      requestId: args.requestId,
      attachments: args.attachments
    });
    input.push(...attachmentInputs);

    if (input.length === 0) {
      throw new Error("turn/start requires prompt text or at least one attachment.");
    }

    return input;
  }

  private async handleDispatch(action: DispatchAction): Promise<void> {
    await this.ack(action, "accepted");

    try {
      if (action.type === "thread.start") {
        await this.ack(action, "running");
        const thread = await this.codex.threadStart({
          cwd: action.cwd,
          model: action.model,
          approvalPolicy: action.approvalPolicy,
          sandbox: action.sandbox
        });
        this.pending.set(action.requestId, {
          requestId: action.requestId,
          threadId: action.requestId
        });
        this.threadBindings.set(thread.thread.id, action.requestId);

        const hasInitialTurn = Boolean(action.prompt?.trim()) || Boolean(action.attachments?.length);
        let startedTurnId: string | undefined;
        if (hasInitialTurn) {
          this.pendingTurnStartAcks.set(thread.thread.id, {
            action,
            codexThreadId: thread.thread.id,
            payload: {
              codexThreadId: thread.thread.id,
              state: "started"
            }
          });
          const input = await this.buildTurnInput({
            prompt: action.prompt,
            requestId: action.requestId,
            cwd: action.cwd,
            attachments: action.attachments
          });

          const turn = await this.codex.turnStart({
            codexThreadId: thread.thread.id,
            input,
            model: action.model,
            reasoningEffort: action.reasoningEffort,
            collaborationMode: action.collaborationMode,
            approvalPolicy: action.approvalPolicy,
            sandbox: action.sandbox
          });
          startedTurnId = turn.turn.id;
          this.activeTurnIds.set(thread.thread.id, startedTurnId);
          await this.completePendingTurnStartAck(thread.thread.id, startedTurnId);
        }

        if (!hasInitialTurn) {
          await this.ack(action, "completed", {
            codexThreadId: thread.thread.id,
            state: "started",
            turnId: startedTurnId
          });
        } else if (this.pendingTurnStartAcks.has(thread.thread.id)) {
          this.pendingTurnStartAcks.delete(thread.thread.id);
          await this.ack(action, "completed", {
            codexThreadId: thread.thread.id,
            state: "started",
            turnId: startedTurnId
          });
        }
        return;
      }

      if (action.type === "thread.hydrate") {
        await this.ack(action, "running");
        this.threadBindings.set(action.codexThreadId, action.threadId);
        const importedItemCount = await this.hydrateThreadHistory(action.threadId, action.codexThreadId);
        await this.ack(action, "completed", { state: "hydrated", importedItemCount });
        return;
      }

      if (action.type === "thread.fork") {
        await this.ack(action, "running");
        const forked = await this.codex.threadFork({
          codexThreadId: action.codexThreadId
        });

        this.threadBindings.set(forked.thread.id, action.childThreadId);

        await this.ack(action, "completed", {
          state: "forked",
          threadId: action.childThreadId,
          codexThreadId: forked.thread.id
        });
        return;
      }

      if (action.type === "turn.start") {
        await this.ack(action, "running");
        this.threadBindings.set(action.codexThreadId, action.threadId);
        this.pendingTurnStartAcks.set(action.codexThreadId, {
          action,
          codexThreadId: action.codexThreadId,
          payload: {
            state: "started"
          }
        });
        const input = await this.buildTurnInput({
          prompt: action.prompt,
          requestId: action.requestId,
          cwd: action.cwd,
          attachments: action.attachments
        });
        const turn = await this.codex.turnStart({
          codexThreadId: action.codexThreadId,
          input,
          model: action.model,
          reasoningEffort: action.reasoningEffort,
          collaborationMode: action.collaborationMode,
          approvalPolicy: action.approvalPolicy,
          sandbox: action.sandbox
        });
        this.activeTurnIds.set(action.codexThreadId, turn.turn.id);
        await this.completePendingTurnStartAck(action.codexThreadId, turn.turn.id);
        if (this.pendingTurnStartAcks.has(action.codexThreadId)) {
          this.pendingTurnStartAcks.delete(action.codexThreadId);
          await this.ack(action, "completed", { state: "started", turnId: turn.turn.id });
        }
        return;
      }

      if (action.type === "review.start") {
        await this.ack(action, "running");
        this.threadBindings.set(action.codexThreadId, action.threadId);
        const review = await this.codex.reviewStart({
          codexThreadId: action.codexThreadId,
          target: action.target,
          delivery: action.delivery
        });
        const durangoReviewThreadId = this.makeDurangoThreadId(review.reviewThreadId);
        this.threadBindings.set(review.reviewThreadId, durangoReviewThreadId);
        this.reviewThreadIds.add(review.reviewThreadId);
        await this.ack(action, "completed", {
          state: "started",
          reviewThreadId: review.reviewThreadId,
          turnId: review.turn.id
        });
        return;
      }

      if (action.type === "project.branches.list") {
        await this.ack(action, "running");
        const [branches, git] = await Promise.all([
          listGitBranches(action.cwd),
          readGitMeta(action.cwd)
        ]);
        await this.ack(action, "completed", {
          branches,
          currentBranch: git.branch ?? null
        });
        return;
      }

      if (action.type === "model.list") {
        await this.ack(action, "running");
        const models = await this.codex.listModels({ limit: 100, maxPages: 5 });
        await this.ack(action, "completed", { models });
        return;
      }

      if (action.type === "turn.interrupt") {
        await this.ack(action, "running");
        await this.codex.turnInterrupt(action.codexThreadId);
        await this.ack(action, "completed", { state: "interrupted" });
      }
    } catch (error) {
      if (action.type === "thread.start" || action.type === "turn.start") {
        const codexThreadId =
          action.type === "thread.start"
            ? Array.from(this.pendingTurnStartAcks.values()).find((entry) => entry.action.requestId === action.requestId)
                ?.codexThreadId ?? null
            : action.codexThreadId;
        if (codexThreadId) {
          this.pendingTurnStartAcks.delete(codexThreadId);
        }
      }
      await this.ack(action, "failed", undefined, {
        code: "APP_SERVER_ERROR",
        message: error instanceof Error ? error.message : "Unknown app-server error"
      });
    }
  }

  private async hydrateThreadHistory(threadId: string, codexThreadId: string): Promise<number> {
    const response = await this.codex.threadRead({
      codexThreadId,
      includeTurns: true
    });

    const turns = this.extractTurnsFromThreadReadResponse(response);
    let timestamp = Date.now() - Math.max(1, turns.length * 100);
    let importedItemCount = 0;

    for (const turn of turns) {
      const turnId = this.getString(turn.id) ?? randomUUID();
      const rawItems = this.extractItemsFromTurn(turn);
      let importedTurnItemCount = 0;
      let hasRunningActivity = false;
      const allowReviewItems = this.reviewThreadIds.has(codexThreadId);

      for (const rawItem of rawItems) {
        const item = this.asObject(rawItem);
        if (!item) {
          const fallbackText = this.extractText(rawItem).trim() || JSON.stringify(rawItem);
          if (!fallbackText) {
            continue;
          }

          this.send({
            type: "event.upsert",
            requestId: turnId,
            machineId: this.config.machineId,
            threadId,
            item: {
              type: "plan",
              id: randomUUID(),
              turnId,
              text: fallbackText,
              timestamp: timestamp++
            }
          });
          importedTurnItemCount += 1;
          importedItemCount += 1;
          continue;
        }

        const mappedItems = this.mapCodexItem(item, turnId, timestamp++, { allowReviewItems });
        if (mappedItems.length === 0) {
          continue;
        }

        for (const mappedItem of mappedItems) {
          if (mappedItem.type === "commandExecution" && mappedItem.status === "running") {
            hasRunningActivity = true;
          }
          this.send({
            type: "event.upsert",
            requestId: turnId,
            machineId: this.config.machineId,
            threadId,
            item: mappedItem
          });
          importedTurnItemCount += 1;
          importedItemCount += 1;
        }
      }

      const turnLifecycleStatus = this.inferHydratedTurnLifecycleStatus(turn, importedTurnItemCount, hasRunningActivity);
      if (turnLifecycleStatus) {
        this.send({
          type: "event.upsert",
          requestId: turnId,
          machineId: this.config.machineId,
          threadId,
            item: {
              type: "plan",
              id: `turn-completed:${turnId}`,
              turnId,
              text: JSON.stringify({
                method: "turn/completed",
              params: { status: turnLifecycleStatus }
            }),
            timestamp: timestamp++
          }
        });
        importedItemCount += 1;
      }
    }

    return importedItemCount;
  }

  private normalizeTurnLifecycleStatus(status: unknown): "running" | "completed" | "failed" | "interrupted" | null {
    const normalized = this.getString(status)?.toLowerCase().trim();
    if (!normalized) {
      return null;
    }

    if (
      normalized === "running" ||
      normalized === "in_progress" ||
      normalized === "inprogress" ||
      normalized === "queued" ||
      normalized === "pending" ||
      normalized === "started"
    ) {
      return "running";
    }

    if (
      normalized === "completed" ||
      normalized === "complete" ||
      normalized === "success" ||
      normalized === "succeeded"
    ) {
      return "completed";
    }

    if (
      normalized === "interrupted" ||
      normalized === "aborted" ||
      normalized === "cancelled" ||
      normalized === "canceled"
    ) {
      return "interrupted";
    }

    if (normalized === "failed" || normalized === "error" || normalized === "errored") {
      return "failed";
    }

    return null;
  }

  private inferHydratedTurnLifecycleStatus(
    turn: Record<string, unknown>,
    importedTurnItemCount: number,
    hasRunningActivity: boolean
  ): "completed" | "failed" | "interrupted" | null {
    const candidates: unknown[] = [
      turn.status,
      this.asObject(turn.result)?.status,
      this.asObject(turn.turn)?.status,
      this.asObject(turn.metadata)?.status
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeTurnLifecycleStatus(candidate);
      if (!normalized) {
        continue;
      }
      if (normalized === "running") {
        return null;
      }
      return normalized;
    }

    if (hasRunningActivity) {
      return null;
    }

    if (importedTurnItemCount > 0) {
      return "completed";
    }

    return null;
  }

  private normalizeTurnEntries(entries: unknown[]): Record<string, unknown>[] {
    return entries.map((entry) => {
      const turn = this.asObject(entry);
      if (turn) {
        return turn;
      }

      return {
        id: randomUUID(),
        items: [entry]
      };
    });
  }

  private extractTurnsFromThreadReadResponse(response: unknown): Record<string, unknown>[] {
    const queue: unknown[] = [response];
    const seen = new Set<Record<string, unknown>>();

    while (queue.length > 0) {
      const current = queue.shift();
      const object = this.asObject(current);
      if (!object || seen.has(object)) {
        continue;
      }
      seen.add(object);

      if (Array.isArray(object.turns)) {
        return this.normalizeTurnEntries(object.turns);
      }

      const turnsPage = this.asObject(object.turnsPage) ?? this.asObject(object.turns_page);
      if (Array.isArray(turnsPage?.data)) {
        return this.normalizeTurnEntries(turnsPage.data);
      }

      if (Array.isArray(object.items)) {
        return [
          {
            id: this.getString(object.id) ?? randomUUID(),
            items: object.items
          }
        ];
      }

      if (object.thread) {
        queue.push(object.thread);
      }
      if (object.result) {
        queue.push(object.result);
      }
      if (object.payload) {
        queue.push(object.payload);
      }
      if (object.response) {
        queue.push(object.response);
      }
      if (object.data && !Array.isArray(object.data)) {
        queue.push(object.data);
      }
    }

    return [];
  }

  private extractItemsFromTurn(turn: Record<string, unknown>): unknown[] {
    const candidates = [turn.items, turn.events, turn.messages, turn.output, turn.content];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }

    if ("item" in turn && turn.item !== undefined) {
      return [turn.item];
    }

    if ("message" in turn && turn.message !== undefined) {
      return [turn.message];
    }

    return [];
  }

  private mapReviewResult(
    input: {
      id?: string;
      turnId: string;
      timestamp?: number;
      summary?: string;
      reviewOutput?: unknown;
    }
  ): DurangoThreadItem | null {
    const reviewOutput = this.asObject(input.reviewOutput);
    const findings = Array.isArray(reviewOutput?.findings)
      ? reviewOutput.findings
          .map((entry) => {
            const finding = this.asObject(entry);
            const codeLocation = this.asObject(finding?.code_location ?? finding?.codeLocation);
            const lineRange = this.asObject(codeLocation?.line_range ?? codeLocation?.lineRange);
            const absoluteFilePath = this.getString(
              codeLocation?.absolute_file_path ?? codeLocation?.absoluteFilePath
            );
            const title = this.getString(finding?.title);
            const body = this.getString(finding?.body);
            const start = this.getNumber(lineRange?.start);
            const end = this.getNumber(lineRange?.end);

            if (!title || !body || !absoluteFilePath || start === null || end === null) {
              return null;
            }

            return {
              title,
              body,
              codeLocation: {
                absoluteFilePath,
                lineRange: {
                  start,
                  end
                }
              },
              confidenceScore:
                this.getNumber(finding?.confidence_score ?? finding?.confidenceScore) ?? 0,
              priority: this.getNumber(finding?.priority) ?? 0
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : [];

    const summary =
      input.summary?.trim() ||
      this.getString(reviewOutput?.overall_explanation ?? reviewOutput?.overallExplanation)?.trim() ||
      "Code review completed.";

    if (!summary && findings.length === 0) {
      return null;
    }

    return {
      type: "reviewResult",
      id: input.id ?? `review:${input.turnId}`,
      turnId: input.turnId,
      summary,
      overallCorrectness:
        this.getString(reviewOutput?.overall_correctness ?? reviewOutput?.overallCorrectness) ?? undefined,
      overallConfidenceScore:
        this.getNumber(reviewOutput?.overall_confidence_score ?? reviewOutput?.overallConfidenceScore) ?? undefined,
      findings,
      timestamp: input.timestamp ?? Date.now()
    };
  }

  private forwardCodexNotification(method: string, params: unknown): void {
    const lowerMethod = method.toLowerCase();
    const codexThreadId = this.extractThreadId(params);
    if (!codexThreadId) {
      return;
    }

    const durangoThreadId = this.threadBindings.get(codexThreadId);
    if (!durangoThreadId) {
      return;
    }

    if (
      lowerMethod.startsWith("thread/") &&
      (lowerMethod.includes("updated") || lowerMethod.includes("renamed") || lowerMethod.includes("title"))
    ) {
      const title = this.extractThreadTitle(params);
      if (!title) {
        return;
      }

      this.send({
        type: "thread.update",
        machineId: this.config.machineId,
        threadId: durangoThreadId,
        title
      });
      return;
    }

    const extractedTurnId = this.extractTurnId(params);
    const mappedTurnId = this.activeTurnIds.get(codexThreadId);
    const turnId =
      lowerMethod === "turn/completed"
        ? mappedTurnId ?? extractedTurnId ?? randomUUID()
        : extractedTurnId ?? mappedTurnId ?? randomUUID();
    if (extractedTurnId && lowerMethod !== "turn/completed" && this.shouldTrackActiveTurnId(extractedTurnId)) {
      this.activeTurnIds.set(codexThreadId, extractedTurnId);
      void this.completePendingTurnStartAck(codexThreadId, extractedTurnId);
    }
    const envelope = this.asObject(params);
    const rawItem = this.asObject(envelope?.item);
    const rawReviewOutput = envelope?.review_output ?? envelope?.reviewOutput;
    const isReviewThread = this.reviewThreadIds.has(codexThreadId);

    let items: DurangoThreadItem[] = [];

    if (lowerMethod === "item/started") {
      if (!rawItem) {
        return;
      }

      const type = this.getString(rawItem.type)?.toLowerCase() ?? "";
      // Emit only live command activity on start; message/reasoning content is emitted on completion.
      if (type === "commandexecution" || type === "command_execution") {
        items = this.mapCodexItem(rawItem, turnId, Date.now(), { allowReviewItems: isReviewThread });
      } else {
        return;
      }
    } else if (lowerMethod === "item/completed") {
      if (rawItem) {
        items = this.mapCodexItem(rawItem, turnId, Date.now(), { allowReviewItems: isReviewThread });
      } else if (isReviewThread) {
        const structuredReview = this.mapReviewResult({
          id: `review:${turnId}`,
          turnId,
          reviewOutput: rawReviewOutput,
          timestamp: Date.now()
        });
        if (structuredReview) {
          items = [structuredReview];
        }
      }
    } else if (lowerMethod === "turn/completed") {
      const status = this.getString(envelope?.status)?.toLowerCase() ?? "completed";
      const errorMessage = this.getString(this.asObject(envelope?.error)?.message);
      items = [
        {
          type: "plan",
          id: `turn-completed:${turnId}`,
          turnId,
          text: JSON.stringify({
            method: "turn/completed",
            params: {
              status,
              ...(errorMessage ? { error: { message: errorMessage } } : {})
            }
          }),
          timestamp: Date.now()
        }
      ];

      if (isReviewThread) {
        const structuredReview = this.mapReviewResult({
          id: `review:${turnId}`,
          turnId,
          reviewOutput: rawReviewOutput,
          timestamp: Date.now()
        });
        if (structuredReview) {
          items.push(structuredReview);
        }
      }
    } else if (
      lowerMethod === "thread/started" ||
      lowerMethod === "turn/started" ||
      lowerMethod.includes("delta") ||
      lowerMethod.includes("updated")
    ) {
      return;
    }

    if (lowerMethod === "turn/completed") {
      this.activeTurnIds.delete(codexThreadId);
      this.pendingTurnStartAcks.delete(codexThreadId);
    }

    if (items.length === 0) {
      items = [
        {
          type: "plan",
          id: randomUUID(),
          turnId,
          text: JSON.stringify({ method, params }),
          timestamp: Date.now()
        }
      ];
    }

    for (const item of items) {
      this.send({
        type: "event.upsert",
        requestId: turnId,
        machineId: this.config.machineId,
        threadId: durangoThreadId,
        item
      });
    }
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private getNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private extractThreadId(params: unknown): string | null {
    const queue: unknown[] = [params];
    while (queue.length > 0) {
      const current = queue.shift();
      const object = this.asObject(current);
      if (!object) {
        continue;
      }

      const threadId = this.getString(object.threadId) ?? this.getString(object.thread_id);
      if (threadId) {
        return threadId;
      }

      if (object.turn) {
        queue.push(object.turn);
      }
      if (object.item) {
        queue.push(object.item);
      }
      if (object.params) {
        queue.push(object.params);
      }
      if (Array.isArray(object.items)) {
        queue.push(...object.items);
      }
    }

    return null;
  }

  private extractThreadTitle(params: unknown): string | null {
    const queue: unknown[] = [params];
    while (queue.length > 0) {
      const current = queue.shift();
      const object = this.asObject(current);
      if (!object) {
        continue;
      }

      const title =
        this.getString(object.title) ??
        this.getString(object.threadTitle) ??
        this.getString(object.thread_title) ??
        this.getString(object.name);
      if (title && title.trim().length > 0) {
        return title.trim();
      }

      if (object.thread) {
        queue.push(object.thread);
      }
      if (object.item) {
        queue.push(object.item);
      }
      if (object.params) {
        queue.push(object.params);
      }
      if (Array.isArray(object.items)) {
        queue.push(...object.items);
      }
    }

    return null;
  }

  private extractTurnId(params: unknown): string | null {
    const queue: unknown[] = [params];
    while (queue.length > 0) {
      const current = queue.shift();
      const object = this.asObject(current);
      if (!object) {
        continue;
      }

      const turnId = this.getString(object.turnId) ?? this.getString(object.turn_id);
      if (turnId) {
        return turnId;
      }

      if (object.turn) {
        queue.push(object.turn);
      }
      if (object.item) {
        queue.push(object.item);
      }
      if (object.params) {
        queue.push(object.params);
      }
    }

    return null;
  }

  private extractText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      const parts = value
        .map((entry) => this.extractText(entry))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return parts.join("\n");
    }

    const object = this.asObject(value);
    if (!object) {
      return "";
    }

    if (typeof object.text === "string") {
      return object.text;
    }

    if (typeof object.value === "string") {
      return object.value;
    }

    if (typeof object.delta === "string") {
      return object.delta;
    }

    if (typeof object.summaryText === "string") {
      return object.summaryText;
    }

    if ("content" in object) {
      return this.extractText(object.content);
    }

    if ("summary" in object) {
      return this.extractText(object.summary);
    }

    if ("output" in object) {
      return this.extractText(object.output);
    }

    return "";
  }

  private extractSummaryLines(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .flatMap((entry) => this.extractSummaryLines(entry))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }

    const object = this.asObject(value);
    if (!object) {
      return [];
    }

    if ("summaryText" in object && typeof object.summaryText === "string") {
      return [object.summaryText];
    }

    if ("text" in object && typeof object.text === "string") {
      return [object.text];
    }

    if ("summary" in object) {
      return this.extractSummaryLines(object.summary);
    }

    if ("content" in object) {
      return this.extractSummaryLines(object.content);
    }

    return [];
  }

  private mapCommandStatus(status: unknown): "running" | "completed" | "failed" {
    const normalized = this.getString(status)?.toLowerCase() ?? "";
    if (normalized === "in_progress" || normalized === "inprogress" || normalized === "running" || normalized === "queued") {
      return "running";
    }

    if (normalized === "completed" || normalized === "success" || normalized === "succeeded") {
      return "completed";
    }

    return "failed";
  }

  private shouldTrackActiveTurnId(turnId: string): boolean {
    const normalized = turnId.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return !normalized.startsWith("auto-compact-");
  }

  private mapCodexItem(
    item: Record<string, unknown>,
    turnId: string,
    timestamp = Date.now(),
    options?: { allowReviewItems?: boolean }
  ): DurangoThreadItem[] {
    const type = this.getString(item.type)?.toLowerCase() ?? "";
    const id = this.getString(item.id) ?? randomUUID();
    const allowReviewItems = options?.allowReviewItems ?? false;

    if (type === "usermessage" || type === "user_message") {
      const text = this.extractText(item.content ?? item.text).trim();
      if (!text) {
        return [];
      }

      return [{ type: "userMessage", id, turnId, text, timestamp }];
    }

    if (type === "agentmessage" || type === "assistant_message" || type === "assistantmessage") {
      const text = this.extractText(item.content ?? item.text).trim();
      if (!text) {
        return [];
      }

      return [{ type: "agentMessage", id, turnId, text, timestamp }];
    }

    if (type === "reasoning") {
      const summary = this.extractSummaryLines(item.summary ?? item.content);
      if (summary.length === 0) {
        return [];
      }

      return [{ type: "reasoning", id, turnId, summary, timestamp }];
    }

    if (type === "commandexecution" || type === "command_execution") {
      const command = this.getString(item.command) ?? "";
      if (!command) {
        return [];
      }

      const output = this.extractText(item.aggregatedOutput ?? item.output).trim();
      return [
        {
          type: "commandExecution",
          id,
          turnId,
          command,
          cwd: this.getString(item.cwd) ?? "",
          status: this.mapCommandStatus(item.status),
          output: output.length > 0 ? output : undefined,
          exitCode: this.getNumber(item.exitCode) ?? undefined,
          timestamp
        }
      ];
    }

    if (type === "filechange" || type === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const mapped = changes
        .map((change, index) => {
          const changeObject = this.asObject(change);
          if (!changeObject) {
            return null;
          }

          const path = this.getString(changeObject.path);
          if (!path) {
            return null;
          }

          const patch = this.extractText(changeObject.patch ?? changeObject.diff).trim() || "(no patch text)";
          return {
            type: "fileChange" as const,
            id: `${id}:${index}`,
            turnId,
            path,
            patch,
            timestamp
          };
        })
        .filter((entry): entry is DurangoThreadItem & { type: "fileChange" } => entry !== null);

      return mapped;
    }

    if (type === "plan") {
      const text = this.extractText(item.text ?? item.content).trim();
      if (!text) {
        return [];
      }

      return [{ type: "plan", id, turnId, text, timestamp }];
    }

    if (type === "enteredreviewmode" || type === "entered_review_mode") {
      if (!allowReviewItems) {
        return [];
      }
      const text = this.extractText(item.review ?? item.text ?? item.content).trim() || "Code review started.";
      return [{ type: "enteredReviewMode", id, turnId, text, timestamp }];
    }

    if (type === "exitedreviewmode" || type === "exited_review_mode") {
      if (!allowReviewItems) {
        return [];
      }
      const reviewResult = this.mapReviewResult({
        id: `review:${turnId}`,
        turnId,
        timestamp,
        summary: this.extractText(item.text ?? item.content).trim(),
        reviewOutput: item.review
      });
      return reviewResult ? [reviewResult] : [];
    }

    const fallbackText = JSON.stringify(item);
    return [{ type: "plan", id, turnId, text: fallbackText, timestamp }];
  }

  private async completePendingTurnStartAck(codexThreadId: string, turnId: string): Promise<void> {
    const pendingAck = this.pendingTurnStartAcks.get(codexThreadId);
    if (!pendingAck) {
      return;
    }

    this.pendingTurnStartAcks.delete(codexThreadId);
    await this.ack(pendingAck.action, "completed", {
      ...pendingAck.payload,
      turnId
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearReconnectTimer();
    this.clearRelayLoopTimers();

    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close();
      }
    }

    await this.codex.stop();
  }
}
