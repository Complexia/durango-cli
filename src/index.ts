#!/usr/bin/env node
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { clearConfig, configPath, readConfig, type CliConfig } from "./config.js";
import { runLogin } from "./login.js";
import { DurangoBridge } from "./bridge.js";
import { postJson, getJson } from "./http.js";
import { readGitMeta } from "./git.js";
import { saveProjectRegistration } from "./projects.js";

const relayUrl = process.env.DURANGO_RELAY_URL ?? "http://localhost:8788";
const webUrl = process.env.DURANGO_WEB_URL ?? "http://localhost:3000";

const ensureLoggedIn = async (): Promise<CliConfig> => {
  const existingConfig = await readConfig();
  if (existingConfig) {
    return existingConfig;
  }

  console.log(`No login session found. Starting browser auth flow (config: ${configPath})...`);
  await runLogin({ relayUrl, webUrl });

  const refreshedConfig = await readConfig();
  if (!refreshedConfig) {
    throw new Error(`Login completed but config file was not written (${configPath}).`);
  }

  return refreshedConfig;
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

const program = new Command();
program
  .name("durango")
  .description("Control local Codex agents from Durango web")
  .version("0.1.0");

program
  .command("login")
  .description("Link this machine to your Durango account")
  .action(async () => {
    await runLogin({ relayUrl, webUrl });
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

    const status = await getJson<{ machineId: string; userId: string; online: boolean; lastHeartbeatAt: number | null }>(
      `${config.relayUrl.replace(/\/$/, "")}/v1/machines/me/status`,
      config.token
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

    const bridge = new DurangoBridge(config);
    await bridge.start();
  });

program
  .action(async () => {
    const config = await ensureLoggedIn();

    const bridge = new DurangoBridge(config);
    await bridge.start();
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
