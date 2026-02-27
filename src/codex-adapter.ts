import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import EventEmitter from "node:events";
import WebSocket from "ws";
import { z } from "zod";

const JsonRpcMessageSchema = z.object({
  // Codex app-server may omit `jsonrpc` in responses; accept both forms.
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional()
    })
    .optional()
});

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type StartCodexOptions = {
  listenUrl?: string;
  codexBin?: string;
};

export type CodexAppServerThreadSummary = {
  id: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
};

export type CodexAppServerThreadReadResponse = {
  thread?: {
    id?: string;
    turns?: Array<{
      id?: string;
      items?: Array<Record<string, unknown>>;
    }>;
  };
};

type ThreadListPage = {
  data?: CodexAppServerThreadSummary[];
  nextCursor?: string | null;
};

export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexTurnInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    }
  | {
      type: "mention";
      name: string;
      path: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    };

export type CodexModelReasoningOption = {
  reasoningEffort: CodexReasoningEffort;
  description: string;
};

export type CodexAppServerModel = {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: CodexReasoningEffort;
  supportedReasoningEfforts: CodexModelReasoningOption[];
  inputModalities: string[];
  isDefault: boolean;
};

type ModelListPage = {
  data?: CodexAppServerModel[];
  nextCursor?: string | null;
};

export class CodexAppServerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private proc: ChildProcess | null = null;
  private procError: Error | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  readonly listenUrl: string;
  readonly codexBin: string;

  constructor(options?: StartCodexOptions) {
    super();
    this.listenUrl = options?.listenUrl ?? process.env.DURANGO_CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:48765";
    this.codexBin = options?.codexBin ?? process.env.DURANGO_CODEX_BIN ?? "codex";
  }

  async start(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.proc) {
      return;
    }

    const connectedToExisting = await this.tryConnectExisting(1_500);
    if (!connectedToExisting) {
      this.spawnServerProcess();
    }

    await this.connect();
    try {
      await this.initialize();
    } catch (error) {
      this.emit("initializeError", error);
      throw error;
    }
  }

  private async tryConnectExisting(timeoutMs: number): Promise<boolean> {
    try {
      await this.connectOnce(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private spawnServerProcess(): void {
    const proc = spawn(this.codexBin, ["app-server", "--listen", this.listenUrl], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.proc = proc;
    this.procError = null;

    proc.stdout?.on("data", (chunk) => {
      this.emit("stdout", chunk.toString());
    });

    proc.stderr?.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });

    proc.on("exit", (code) => {
      this.emit("processExit", code);
      this.proc = null;
    });

    proc.on("error", (error) => {
      this.procError = error;
      this.emit("processError", error);
    });
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const startedAt = Date.now();
    const maxWaitMs = 25_000;
    let lastError: unknown = null;

    while (Date.now() - startedAt < maxWaitMs) {
      if (this.procError) {
        throw new Error(
          `Failed to start codex app-server with binary "${this.codexBin}": ${this.procError.message}`
        );
      }

      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(
          `codex app-server exited early with code ${this.proc.exitCode}. Check local Codex installation.`
        );
      }

      try {
        await this.connectOnce(2_000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Timed out connecting to codex app-server at ${this.listenUrl} after ${maxWaitMs}ms (${reason})`
    );
  }

  private async connectOnce(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.listenUrl, {
        perMessageDeflate: false
      });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("connect timeout"));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        this.bindSocket(ws);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore close errors on failed connection attempts.
        }
        reject(err);
      });
    });
  }

  private bindSocket(ws: WebSocket): void {
    ws.on("message", (data) => {
      const text = data.toString();
      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch (error) {
        this.emit("malformedMessage", { text, error });
        return;
      }

      const msg = JsonRpcMessageSchema.safeParse(parsed);
      if (!msg.success) {
        this.emit("invalidMessage", { parsed, issues: msg.error.issues });
        return;
      }

      const message = msg.data;
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(String(message.id));
        if (!pending) {
          return;
        }

        this.pending.delete(String(message.id));
        clearTimeout(pending.timeout);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method) {
        this.emit("notification", {
          method: message.method,
          params: message.params
        } satisfies JsonRpcNotification);
      }
    });

    ws.on("close", () => {
      this.emit("disconnected");
      this.ws = null;
    });

    ws.on("error", (error) => {
      this.emit("socketError", error);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "durango-cli",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", undefined);
  }

  request<TResponse = unknown>(method: string, params: unknown): Promise<TResponse> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server socket is not open"));
    }

    const id = randomUUID();
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params
    };

    return new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, 30_000);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      ws.send(JSON.stringify(payload));
    });
  }

  notify(method: string, params: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })
    );
  }

  async getAuthStatus(): Promise<unknown> {
    return this.request("getAuthStatus", {});
  }

  async listThreads(args?: {
    limit?: number;
    maxPages?: number;
  }): Promise<CodexAppServerThreadSummary[]> {
    const pageLimit = Math.min(100, Math.max(1, args?.limit ?? 50));
    const maxPages = Math.min(20, Math.max(1, args?.maxPages ?? 5));

    const threads: CodexAppServerThreadSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;

    while (pages < maxPages) {
      const response = await this.request<ThreadListPage>("thread/list", {
        limit: pageLimit,
        cursor
      });

      const page = Array.isArray(response.data) ? response.data : [];
      threads.push(...page);
      pages += 1;

      if (!response.nextCursor || page.length === 0) {
        break;
      }
      cursor = response.nextCursor;
    }

    return threads;
  }

  async listModels(args?: {
    limit?: number;
    maxPages?: number;
  }): Promise<CodexAppServerModel[]> {
    const pageLimit = Math.min(100, Math.max(1, args?.limit ?? 50));
    const maxPages = Math.min(20, Math.max(1, args?.maxPages ?? 5));

    const models: CodexAppServerModel[] = [];
    let cursor: string | undefined;
    let pages = 0;

    while (pages < maxPages) {
      const response = await this.request<ModelListPage>("model/list", {
        limit: pageLimit,
        cursor
      });

      const page = Array.isArray(response.data) ? response.data : [];
      models.push(...page);
      pages += 1;

      if (!response.nextCursor || page.length === 0) {
        break;
      }
      cursor = response.nextCursor;
    }

    return models;
  }

  async threadStart(args: {
    cwd: string;
    model?: string;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<{ thread: { id: string } }> {
    return this.request("thread/start", {
      cwd: args.cwd,
      model: args.model ?? null,
      approvalPolicy: args.approvalPolicy ?? "never",
      sandbox: args.sandbox ?? "danger-full-access",
      experimentalRawEvents: true
    });
  }

  async threadRead(args: {
    codexThreadId: string;
    includeTurns?: boolean;
  }): Promise<CodexAppServerThreadReadResponse> {
    return this.request("thread/read", {
      threadId: args.codexThreadId,
      includeTurns: args.includeTurns ?? true
    });
  }

  async turnStart(args: {
    codexThreadId: string;
    prompt?: string;
    input?: CodexTurnInputItem[];
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<{ turn: { id: string } }> {
    const input: CodexTurnInputItem[] =
      args.input && args.input.length > 0
        ? args.input
        : args.prompt
          ? [
              {
                type: "text",
                text: args.prompt
              }
            ]
          : [];

    if (input.length === 0) {
      throw new Error("turn/start requires at least one input item.");
    }

    return this.request("turn/start", {
      threadId: args.codexThreadId,
      input: input.map((item) => {
        if (item.type === "text") {
          return {
            type: "text",
            text: item.text,
            text_elements: []
          };
        }

        if (item.type === "image") {
          return {
            type: "image",
            url: item.url
          };
        }

        if (item.type === "localImage") {
          return {
            type: "localImage",
            path: item.path
          };
        }

        if (item.type === "mention") {
          return {
            type: "mention",
            name: item.name,
            path: item.path
          };
        }

        return {
          type: "skill",
          name: item.name,
          path: item.path
        };
      }),
      model: args.model ?? null,
      effort: args.reasoningEffort ?? null,
      approvalPolicy: args.approvalPolicy ?? null,
      sandboxPolicy: args.sandbox ? { mode: args.sandbox } : null
    });
  }

  async turnInterrupt(codexThreadId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId: codexThreadId });
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Client closed before response: ${id}`));
      this.pending.delete(id);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
