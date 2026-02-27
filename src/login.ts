import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import open from "open";
import { postJson } from "./http.js";
import { writeConfig } from "./config.js";

type LoginOptions = {
  relayUrl: string;
  webUrl: string;
};

const renderCallbackPage = (opts: { status: "success" | "error"; title: string; description: string }): string => {
  const isSuccess = opts.status === "success";
  const badgeColor = isSuccess ? "rgba(251, 146, 60, 0.16)" : "rgba(244, 63, 94, 0.16)";
  const badgeBorder = isSuccess ? "rgba(251, 146, 60, 0.45)" : "rgba(244, 63, 94, 0.45)";
  const badgeText = isSuccess ? "#fdba74" : "#fda4af";
  const buttonBg = isSuccess ? "#f97316" : "#e11d48";
  const buttonShadow = isSuccess ? "rgba(249, 115, 22, 0.35)" : "rgba(225, 29, 72, 0.35)";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Durango CLI Link</title>
    <style>
      :root {
        color-scheme: dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        position: relative;
        display: grid;
        place-items: center;
        padding: 24px;
        overflow: hidden;
        background: #09090b;
        color: #fafafa;
        font-family: "Space Grotesk", "Inter", "Segoe UI", sans-serif;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(circle at 20% 15%, rgba(251, 146, 60, 0.22), transparent 32%),
          radial-gradient(circle at 80% 85%, rgba(34, 197, 94, 0.16), transparent 30%);
      }

      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
        background-size: 58px 58px;
        mask-image: radial-gradient(circle at center, black 35%, transparent 85%);
      }

      .card {
        position: relative;
        width: min(640px, 100%);
        border: 1px solid rgba(63, 63, 70, 0.9);
        border-radius: 16px;
        background: rgba(24, 24, 27, 0.72);
        backdrop-filter: blur(8px);
        padding: 28px;
        box-shadow: 0 25px 90px rgba(0, 0, 0, 0.5);
      }

      .header {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .logo {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: rgba(249, 115, 22, 0.92);
        color: #09090b;
        font-weight: 700;
        line-height: 1;
      }

      .brand {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
      }

      .subtitle {
        margin: 2px 0 0;
        color: #a1a1aa;
        font-size: 0.75rem;
      }

      .badge {
        width: fit-content;
        margin: 18px 0 0;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid ${badgeBorder};
        background: ${badgeColor};
        color: ${badgeText};
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      h1 {
        margin: 14px 0 0;
        font-size: clamp(1.85rem, 5vw, 2.45rem);
        line-height: 1.06;
        letter-spacing: -0.02em;
      }

      p {
        margin: 10px 0 0;
        color: #d4d4d8;
        font-size: 1rem;
      }

      .hint {
        margin-top: 18px;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(63, 63, 70, 1);
        background: rgba(9, 9, 11, 0.7);
        color: #e4e4e7;
        font-family: "IBM Plex Mono", "SF Mono", "Menlo", monospace;
        font-size: 0.86rem;
      }

      .button {
        margin-top: 16px;
        border: 0;
        border-radius: 10px;
        background: ${buttonBg};
        color: #111827;
        font-weight: 700;
        padding: 10px 14px;
        cursor: pointer;
        box-shadow: 0 10px 28px ${buttonShadow};
      }

      .button:hover {
        filter: brightness(1.05);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="header">
        <div class="logo">D</div>
        <div>
          <p class="brand">Durango</p>
          <p class="subtitle">Web-controlled local Codex runtime</p>
        </div>
      </div>
      <p class="badge">${isSuccess ? "CLI Linked" : "CLI Link Failed"}</p>
      <h1>${opts.title}</h1>
      <p>${opts.description}</p>
      <div class="hint">${isSuccess ? "Return to your terminal to continue." : "Retry `durango` from your terminal."}</div>
      <button class="button" type="button" onclick="window.close()">Close tab</button>
    </main>
  </body>
</html>`;
};

const waitForCode = async (webUrl: string): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1:53682");
      const code = url.searchParams.get("code");

      if (url.pathname === "/callback" && code) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          renderCallbackPage({
            status: "success",
            title: "Durango CLI linked.",
            description: "This machine is now connected. You can return to the terminal."
          })
        );
        server.close();
        resolve(code);
        return;
      }

      res.statusCode = 400;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        renderCallbackPage({
          status: "error",
          title: "Missing authorization code.",
          description: "This callback URL is incomplete. Please restart login from the CLI."
        })
      );
    });

    server.listen(53682, "127.0.0.1", () => {
      const callback = encodeURIComponent("http://127.0.0.1:53682/callback");
      const connectUrl = `${webUrl.replace(/\/$/, "")}/connect/cli?callback=${callback}`;
      void open(connectUrl);
      console.log(`Opened browser for login: ${connectUrl}`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for login callback"));
    }, 5 * 60_000);
  });
};

export const runLogin = async (opts: LoginOptions): Promise<void> => {
  const machineId = randomUUID();
  const code = await waitForCode(opts.webUrl);

  const exchange = await postJson<{
    token: string;
    userId: string;
    machineId: string;
  }>(`${opts.relayUrl.replace(/\/$/, "")}/v1/cli/auth/exchange`, {
    code,
    machine: {
      machineId,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osVersion: os.release(),
      cliVersion: "0.1.0"
    }
  });

  await writeConfig({
    machineId: exchange.machineId,
    token: exchange.token,
    userId: exchange.userId,
    relayUrl: opts.relayUrl,
    webUrl: opts.webUrl
  });

  console.log(`Linked Durango CLI to user ${exchange.userId} on machine ${exchange.machineId}`);
};
