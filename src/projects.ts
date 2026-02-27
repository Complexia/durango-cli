import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.js";

export type ProjectRegistration = {
  id: string;
  machineId: string;
  absolutePath: string;
  name: string;
  gitBranch?: string;
  gitRemoteUrl?: string;
};

type LocalProjectFile = {
  version: 1;
  project: {
    id: string;
    machineId: string;
    name: string;
    gitBranch?: string;
    gitRemoteUrl?: string;
    createdAt: number;
  };
};

const DURANGO_PROJECT_DIR = ".durango";
const DURANGO_PROJECT_FILE = "project.json";
const PROJECT_REGISTRY_FILE = path.join(configDir, "projects.json");

const projectFilePath = (absolutePath: string): string =>
  path.join(absolutePath, DURANGO_PROJECT_DIR, DURANGO_PROJECT_FILE);

const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const parseLocalProjectFile = (raw: unknown): LocalProjectFile | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const maybe = raw as Record<string, unknown>;
  if (maybe.version !== 1 || typeof maybe.project !== "object" || maybe.project === null) {
    return null;
  }

  const project = maybe.project as Record<string, unknown>;
  if (!isString(project.id) || !isString(project.machineId) || !isString(project.name)) {
    return null;
  }

  const gitBranch = isString(project.gitBranch) ? project.gitBranch : undefined;
  const gitRemoteUrl = isString(project.gitRemoteUrl) ? project.gitRemoteUrl : undefined;
  const createdAt = typeof project.createdAt === "number" ? project.createdAt : Date.now();

  return {
    version: 1,
    project: {
      id: project.id,
      machineId: project.machineId,
      name: project.name,
      gitBranch,
      gitRemoteUrl,
      createdAt
    }
  };
};

const readLocalProjectFile = async (absolutePath: string): Promise<LocalProjectFile | null> => {
  try {
    const raw = await readFile(projectFilePath(absolutePath), "utf8");
    return parseLocalProjectFile(JSON.parse(raw));
  } catch {
    return null;
  }
};

const readProjectRegistry = async (): Promise<string[]> => {
  try {
    const raw = await readFile(PROJECT_REGISTRY_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isString).map((entry) => path.resolve(entry));
  } catch {
    return [];
  }
};

const writeProjectRegistry = async (entries: string[]): Promise<void> => {
  await mkdir(configDir, { recursive: true });
  const deduped = Array.from(new Set(entries.map((entry) => path.resolve(entry))));
  await writeFile(PROJECT_REGISTRY_FILE, JSON.stringify(deduped, null, 2), "utf8");
};

const ensureProjectInRegistry = async (absolutePath: string): Promise<void> => {
  const filePath = projectFilePath(absolutePath);
  const existing = await readProjectRegistry();
  if (existing.includes(filePath)) {
    return;
  }

  await writeProjectRegistry([...existing, filePath]);
};

export const saveProjectRegistration = async (input: {
  absolutePath: string;
  machineId: string;
  gitBranch?: string;
  gitRemoteUrl?: string;
}): Promise<ProjectRegistration> => {
  const absolutePath = path.resolve(input.absolutePath);
  const existing = await readLocalProjectFile(absolutePath);
  const createdAt = existing?.project.createdAt ?? Date.now();

  const project: LocalProjectFile = {
    version: 1,
    project: {
      id: existing?.project.id ?? randomUUID(),
      machineId: input.machineId,
      name: path.basename(absolutePath),
      gitBranch: input.gitBranch,
      gitRemoteUrl: input.gitRemoteUrl,
      createdAt
    }
  };

  const filePath = projectFilePath(absolutePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(project, null, 2), "utf8");
  await ensureProjectInRegistry(absolutePath);

  return {
    id: project.project.id,
    machineId: input.machineId,
    absolutePath,
    name: project.project.name,
    gitBranch: project.project.gitBranch,
    gitRemoteUrl: project.project.gitRemoteUrl
  };
};

export const loadProjectsForMachine = async (machineId: string): Promise<ProjectRegistration[]> => {
  const entries = await readProjectRegistry();
  if (entries.length === 0) {
    return [];
  }

  const validEntries: string[] = [];
  const projects: ProjectRegistration[] = [];

  for (const entry of entries) {
    const absoluteFilePath = path.resolve(entry);
    try {
      const raw = await readFile(absoluteFilePath, "utf8");
      const parsed = parseLocalProjectFile(JSON.parse(raw));
      if (!parsed) {
        continue;
      }

      const absolutePath = path.dirname(path.dirname(absoluteFilePath));
      projects.push({
        id: parsed.project.id,
        machineId,
        absolutePath,
        name: parsed.project.name || path.basename(absolutePath),
        gitBranch: parsed.project.gitBranch,
        gitRemoteUrl: parsed.project.gitRemoteUrl
      });
      validEntries.push(absoluteFilePath);
    } catch {
      // Ignore missing/invalid entries; registry will be compacted below.
    }
  }

  if (validEntries.length !== entries.length) {
    await writeProjectRegistry(validEntries);
  }

  return projects;
};
