#!/usr/bin/env node
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { clearConfig, configPath, ensureMachineId, readConfig, type CliConfig } from "./config.js";
import { runLogin } from "./login.js";
import { DurangoBridge } from "./bridge.js";
import { postJson, getJson } from "./http.js";
import { readGitMeta } from "./git.js";
import { saveProjectRegistration } from "./projects.js";

const LOCAL_DEFAULTS = {
  relayUrl: "http://localhost:8788",
  webUrl: "http://localhost:3000"
} as const;

const PRODUCTION_DEFAULTS = {
  relayUrl: "https://relay-api.durango.sh",
  webUrl: "https://durango.sh"
} as const;

export const isSourceCheckout = (): boolean => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return existsSync(path.join(moduleDir, "../src/index.ts"));
};

export const resolveDurangoUrls = (): { relayUrl: string; webUrl: string } => {
  const defaults = isSourceCheckout() ? LOCAL_DEFAULTS : PRODUCTION_DEFAULTS;
  return {
    relayUrl: process.env.DURANGO_RELAY_URL ?? defaults.relayUrl,
    webUrl: process.env.DURANGO_WEB_URL ?? defaults.webUrl
  };
};

const applyRuntimeUrls = (
  config: CliConfig,
  urls: { relayUrl: string; webUrl: string }
): CliConfig => ({
  ...config,
  relayUrl: urls.relayUrl,
  webUrl: urls.webUrl
});

const requireConfig = async (message: string): Promise<CliConfig> => {
  const urls = resolveDurangoUrls();
  const config = await readConfig();
  if (!config) {
    throw new Error(message);
  }

  return applyRuntimeUrls(config, urls);
};

const ensureLoggedIn = async (): Promise<CliConfig> => {
  const urls = resolveDurangoUrls();
  const existingConfig = await readConfig();
  if (existingConfig) {
    await ensureMachineId(existingConfig.machineId);
    if (existingConfig.relayUrl === urls.relayUrl) {
      return applyRuntimeUrls(existingConfig, urls);
    }

    console.log(
      `Stored Durango session targets ${existingConfig.relayUrl}, but this run targets ${urls.relayUrl}. Starting browser auth flow for the current relay...`
    );
    await runLogin(urls);
    return requireConfig(`Login completed but config file was not written (${configPath}).`);
  }

  console.log(`No login session found. Starting browser auth flow (config: ${configPath})...`);
  await runLogin(urls);

  return requireConfig(`Login completed but config file was not written (${configPath}).`);
};

const startBridgeSession = async (config: CliConfig): Promise<void> => {
  const bridge = new DurangoBridge(config);
  await bridge.start();
};

const loginAndConnect = async (): Promise<void> => {
  const urls = resolveDurangoUrls();
  await runLogin(urls);
  const config = await requireConfig(`Login completed but config file was not written (${configPath}).`);
  await startBridgeSession(config);
};

export const createProgram = (): Command => {
  const program = new Command();
  program
    .name("durango")
    .description("Control local Codex agents from Durango web")
    .version("0.1.3");

  program
    .command("login")
    .description("Link this machine to your Durango account and start the local bridge")
    .action(async () => {
      await loginAndConnect();
    });

  program
    .command("init")
    .description("Register current folder as a Durango project")
    .action(async () => {
      const config = await ensureLoggedIn();

      const cwd = process.cwd();
      const git = await readGitMeta(cwd);
      const project = await saveProjectRegistration({
        absolutePath: cwd,
        machineId: config.machineId,
        gitBranch: git.branch,
        gitRemoteUrl: git.remoteUrl
      });

      const result = await postJson<{ ok: boolean }>(
        `${config.relayUrl.replace(/\/$/, "")}/v1/projects/register`,
        { project },
        config.token
      );

      if (result.ok) {
        console.log(`Registered project ${project.name} (${project.absolutePath})`);
      }
    });

  program
    .command("status")
    .description("Show relay connectivity and auth status")
    .action(async () => {
      const config = await readConfig();
      if (!config) {
        console.log("Not logged in.");
        return;
      }

      const urls = resolveDurangoUrls();
      if (config.relayUrl !== urls.relayUrl) {
        console.log(
          JSON.stringify(
            {
              error: "Stored Durango session targets a different relay. Run `durango login` for this environment.",
              storedRelayUrl: config.relayUrl,
              targetRelayUrl: urls.relayUrl,
              configPath
            },
            null,
            2
          )
        );
        return;
      }

      const runtimeConfig = applyRuntimeUrls(config, urls);

      const status = await getJson<{ machineId: string; userId: string; online: boolean; lastHeartbeatAt: number | null }>(
        `${runtimeConfig.relayUrl.replace(/\/$/, "")}/v1/machines/me/status`,
        runtimeConfig.token
      );

      console.log(JSON.stringify({ ...status, configPath }, null, 2));
    });

  program
    .command("logout")
    .description("Remove local auth token")
    .action(async () => {
      await clearConfig();
      console.log("Durango config cleared.");
    });

  program
    .command("start")
    .description("Start Durango local bridge session")
    .action(async () => {
      const config = await ensureLoggedIn();
      await startBridgeSession(config);
    });

  program
    .action(async () => {
      const config = await ensureLoggedIn();
      await startBridgeSession(config);
    });

  return program;
};

if (process.versions.bun && process.env.DURANGO_NODE_RELAUNCHED !== "1") {
  const nodeBin = process.env.DURANGO_NODE_BIN ?? "node";
  const relaunched = spawnSync(nodeBin, process.argv.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      DURANGO_NODE_RELAUNCHED: "1"
    }
  });

  if (relaunched.error) {
    console.error(
      `Failed to relaunch Durango CLI with Node (${nodeBin}): ${relaunched.error.message}`
    );
    process.exit(1);
  }

  process.exit(relaunched.status ?? 0);
}

export const main = async (argv: string[] = process.argv): Promise<void> => {
  const program = createProgram();
  await program.parseAsync(argv);
};

const isDirectRun = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
