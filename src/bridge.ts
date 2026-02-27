import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import WebSocket from "ws";
import type { DispatchAction, DurangoThreadItem, RelayClientMessage, RelayServerMessage } from "./protocol.js";
import { CodexAppServerClient, type CodexTurnInputItem } from "./codex-adapter.js";
import type { CliConfig } from "./config.js";
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

type DispatchAttachment = NonNullable<Extract<DispatchAction, { type: "turn.start" }>["attachments"]>[number];

export class DurangoBridge {
  private readonly codex = new CodexAppServerClient();
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingRun>();
  private readonly threadBindings = new Map<string, string>();

  constructor(private readonly config: CliConfig) {}

  async start(): Promise<void> {
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

    await this.connectRelay();
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
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
      normalized.includes("state db missing rollout path for thread") ||
      normalized.includes("find_thread_path_by_id_str_in_subdir") ||
      normalized.includes("state db record_discrepancy")
    );
  }

  private async connectRelay(): Promise<void> {
    const wsUrl = relayWsUrl(this.config.relayUrl);
    this.ws = new WebSocket(wsUrl, {
      perMessageDeflate: false
    });

    this.ws.on("open", () => {
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
          cliVersion: "0.1.0",
          codexVersion: process.env.CODEX_VERSION ?? "unknown"
        }
      };

      this.ws?.send(JSON.stringify(hello));
    });

    this.ws.on("message", async (data) => {
      const message = JSON.parse(data.toString()) as RelayServerMessage;

      if (message.type === "session.ready") {
        console.log(`Connected to relay as machine ${message.machineId}`);
        this.startHeartbeat(message.heartbeatIntervalMs);
        const projects = await this.syncProjects();
        await this.syncThreads(projects);
        return;
      }

      if (message.type === "session.error") {
        console.error(`Relay session error: ${message.error.code} ${message.error.message}`);
        if (!message.recoverable) {
          await this.stop();
          process.exit(1);
        }
        return;
      }

      if (message.type === "dispatch.request") {
        await this.handleDispatch(message.action);
      }
    });

    this.ws.on("close", () => {
      console.log("Disconnected from relay.");
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    });

    this.ws.on("error", (error) => {
      console.error("Relay websocket error", error);
    });

    await new Promise<void>((resolve, reject) => {
      this.ws?.once("open", () => resolve());
      this.ws?.once("error", (err) => reject(err));
    });
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

  private async syncProjects(): Promise<ProjectRegistration[]> {
    const projects = await loadProjectsForMachine(this.config.machineId);
    if (projects.length === 0) {
      return [];
    }

    const endpoint = `${this.config.relayUrl.replace(/\/$/, "")}/v1/projects/register`;
    let synced = 0;

    for (const project of projects) {
      try {
        const result = await postJson<{ ok: boolean }>(endpoint, { project }, this.config.token);
        if (result.ok) {
          synced += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`Failed to sync project ${project.absolutePath}: ${message}`);
      }
    }

    if (synced > 0) {
      console.log(`Synced ${synced} local project${synced === 1 ? "" : "s"} with relay.`);
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

      const durangoThreadId = this.makeDurangoThreadId(codexThreadId);
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

    if (synced > 0) {
      console.log(`Synced ${synced} saved thread${synced === 1 ? "" : "s"} from codex app-server.`);
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
    prompt: string;
    requestId: string;
    cwd?: string;
    attachments?: DispatchAttachment[];
  }): Promise<CodexTurnInputItem[]> {
    const prompt = args.prompt.trim();
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

        const input = await this.buildTurnInput({
          prompt: action.prompt,
          requestId: action.requestId,
          cwd: action.cwd,
          attachments: action.attachments
        });

        await this.codex.turnStart({
          codexThreadId: thread.thread.id,
          input,
          model: action.model,
          reasoningEffort: action.reasoningEffort,
          approvalPolicy: action.approvalPolicy,
          sandbox: action.sandbox
        });

        this.pending.set(action.requestId, {
          requestId: action.requestId,
          threadId: action.requestId
        });
        this.threadBindings.set(thread.thread.id, action.requestId);

        await this.ack(action, "completed", {
          codexThreadId: thread.thread.id,
          state: "started"
        });
        return;
      }

      if (action.type === "thread.hydrate") {
        await this.ack(action, "running");
        this.threadBindings.set(action.codexThreadId, action.threadId);
        const importedItemCount = await this.hydrateThreadHistory(action.threadId, action.codexThreadId);
        await this.ack(action, "completed", { state: "hydrated", importedItemCount });
        return;
      }

      if (action.type === "turn.start") {
        await this.ack(action, "running");
        this.threadBindings.set(action.codexThreadId, action.threadId);
        const input = await this.buildTurnInput({
          prompt: action.prompt,
          requestId: action.requestId,
          cwd: action.cwd,
          attachments: action.attachments
        });
        await this.codex.turnStart({
          codexThreadId: action.codexThreadId,
          input,
          model: action.model,
          reasoningEffort: action.reasoningEffort,
          approvalPolicy: action.approvalPolicy,
          sandbox: action.sandbox
        });
        await this.ack(action, "completed", { state: "started" });
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

        const mappedItems = this.mapCodexItem(item, turnId, timestamp++);
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
            id: randomUUID(),
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

    const turnId = this.extractTurnId(params) ?? randomUUID();
    const envelope = this.asObject(params);
    const rawItem = this.asObject(envelope?.item);

    let items: DurangoThreadItem[] = [];

    if (lowerMethod === "item/started") {
      if (!rawItem) {
        return;
      }

      const type = this.getString(rawItem.type)?.toLowerCase() ?? "";
      // Emit only live command activity on start; message/reasoning content is emitted on completion.
      if (type === "commandexecution" || type === "command_execution") {
        items = this.mapCodexItem(rawItem, turnId);
      } else {
        return;
      }
    } else if (lowerMethod === "item/completed") {
      if (rawItem) {
        items = this.mapCodexItem(rawItem, turnId);
      }
    } else if (lowerMethod === "turn/completed") {
      const status = this.getString(envelope?.status)?.toLowerCase() ?? "completed";
      const errorMessage = this.getString(this.asObject(envelope?.error)?.message);
      if (status !== "completed" && status !== "success") {
        items = [
          {
            type: "plan",
            id: randomUUID(),
            turnId,
            text: `Turn ended with status "${status}"${errorMessage ? `: ${errorMessage}` : ""}.`,
            timestamp: Date.now()
          }
        ];
      }
    } else if (
      lowerMethod === "thread/started" ||
      lowerMethod === "turn/started" ||
      lowerMethod.includes("delta") ||
      lowerMethod.includes("updated")
    ) {
      return;
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

  private mapCodexItem(item: Record<string, unknown>, turnId: string, timestamp = Date.now()): DurangoThreadItem[] {
    const type = this.getString(item.type)?.toLowerCase() ?? "";
    const id = this.getString(item.id) ?? randomUUID();

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

    const fallbackText = JSON.stringify(item);
    return [{ type: "plan", id, turnId, text: fallbackText, timestamp }];
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;

    await this.codex.stop();
  }
}
