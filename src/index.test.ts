import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliConfig } from "./config.js";

const testConfig: CliConfig = {
  machineId: "machine-test",
  userId: "user-test",
  token: "token-test",
  relayUrl: "https://relay-api.durango.sh",
  webUrl: "https://durango.sh"
};

const runLogin = vi.fn<() => Promise<void>>();
const readConfig = vi.fn<() => Promise<CliConfig | null>>();
const ensureMachineId = vi.fn<() => Promise<string>>();
const bridgeStart = vi.fn<() => Promise<void>>();

vi.mock("./login.js", () => ({
  runLogin
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    configDir: "/tmp/durango",
    configPath: "/tmp/durango/config.json",
    clearConfig: vi.fn(),
    ensureMachineId,
    readConfig,
    writeConfig: vi.fn(),
    readMachineId: vi.fn()
  };
});

vi.mock("./bridge.js", () => ({
  DurangoBridge: class {
    constructor(_config: CliConfig) {}

    async start(): Promise<void> {
      await bridgeStart();
    }
  }
}));

describe("CLI login flow", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the bridge after login completes", async () => {
    runLogin.mockResolvedValueOnce();
    readConfig.mockResolvedValueOnce(testConfig);

    const { createProgram } = await import("./index.js");
    const program = createProgram();

    await program.parseAsync(["node", "durango", "login"]);

    expect(runLogin).toHaveBeenCalledWith({
      relayUrl: "https://relay-api.durango.sh",
      webUrl: "https://durango.sh"
    });
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(bridgeStart).toHaveBeenCalledTimes(1);
  });
});
