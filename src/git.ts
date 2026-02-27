import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const gitOutput = async (cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

export const readGitMeta = async (cwd: string): Promise<{ branch?: string; remoteUrl?: string }> => {
  const [branch, remoteUrl] = await Promise.all([
    gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitOutput(cwd, ["config", "--get", "remote.origin.url"])
  ]);

  return { branch, remoteUrl };
};
