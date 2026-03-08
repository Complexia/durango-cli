import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const gitOutput = async (cwd: string, args: string[]): Promise<string | undefined> => {
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

export type GitBranchRef = {
  name: string;
  type: "local" | "remote";
};

export const listGitBranches = async (cwd: string): Promise<GitBranchRef[]> => {
  const raw = await gitOutput(cwd, [
    "for-each-ref",
    "--format=%(refname:short)\t%(refname)",
    "refs/heads",
    "refs/remotes"
  ]);
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const branches: GitBranchRef[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const [shortRef = "", fullRef = ""] = line.split("\t");
    const name = shortRef.trim();
    if (!name || name.endsWith("/HEAD") || seen.has(name)) {
      continue;
    }

    branches.push({
      name,
      type: fullRef.startsWith("refs/remotes/") ? "remote" : "local"
    });
    seen.add(name);
  }

  return branches.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "local" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
};
