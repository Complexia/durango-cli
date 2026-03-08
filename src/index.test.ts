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

vi.mock("./config.js", async () => {
  return {
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
    delete process.env.DURANGO_RELAY_URL;
    delete process.env.DURANGO_WEB_URL;
  });

  it("starts the bridge after login completes", async () => {
    runLogin.mockResolvedValueOnce();
    readConfig.mockResolvedValueOnce(testConfig);

    const { createProgram } = await import("./index.js");
    const program = createProgram();

    await program.parseAsync(["node", "durango", "login"]);

    expect(runLogin).toHaveBeenCalledWith({
      relayUrl: "http://localhost:8788",
      webUrl: "http://localhost:3000"
    });
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(bridgeStart).toHaveBeenCalledTimes(1);
  });

  it("re-links when the stored session points at a different relay", async () => {
    const localConfig: CliConfig = {
      ...testConfig,
      relayUrl: "http://localhost:8788",
      webUrl: "http://localhost:3000"
    };

    readConfig
      .mockResolvedValueOnce(testConfig)
      .mockResolvedValueOnce(localConfig);
    ensureMachineId.mockResolvedValueOnce("machine-test");
    runLogin.mockResolvedValueOnce();

    const { createProgram } = await import("./index.js");
    const program = createProgram();

    await program.parseAsync(["node", "durango"]);

    expect(runLogin).toHaveBeenCalledWith({
      relayUrl: "http://localhost:8788",
      webUrl: "http://localhost:3000"
    });
    expect(bridgeStart).toHaveBeenCalledTimes(1);
  });

  it("uses explicit relay overrides when provided", async () => {
    process.env.DURANGO_RELAY_URL = "https://relay.example.test";
    process.env.DURANGO_WEB_URL = "https://web.example.test";
    runLogin.mockResolvedValueOnce();
    readConfig.mockResolvedValueOnce({
      ...testConfig,
      relayUrl: "https://relay.example.test",
      webUrl: "https://web.example.test"
    });

    const { createProgram } = await import("./index.js");
    const program = createProgram();

    await program.parseAsync(["node", "durango", "login"]);

    expect(runLogin).toHaveBeenCalledWith({
      relayUrl: "https://relay.example.test",
      webUrl: "https://web.example.test"
    });
  });
});
