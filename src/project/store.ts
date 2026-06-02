import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, normalize, posix, relative, resolve } from "node:path";
import { homedir } from "node:os";

export const PROJECTS_VERSION = 1;
export const DEFAULT_PROJECTS_PATH = join(homedir(), ".multi-agent", "projects.json");

export interface Project {
  id: string;
  name: string;
  root: string;           // absolute OS path
  pinnedFile: string | null; // root-relative POSIX path
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSet {
  version: 1;
  activeId: string;
  projects: Project[];
}

/**
 * Returns true when candidate is the same as base or nested under it.
 * Uses both lexical containment and realpathSync to prevent symlink escapes.
 * When either path doesn't exist yet, falls back to lexical result only.
 */
export function pathContains(base: string, candidate: string): boolean {
  const absBase = resolve(base);
  const absCandidate = resolve(candidate);
  const rel = relative(absBase, absCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    const realBase = realpathSync(absBase);
    const realCandidate = realpathSync(absCandidate);
    const realRel = relative(realBase, realCandidate);
    return !realRel.startsWith("..") && !isAbsolute(realRel);
  } catch {
    return true; // one or both don't exist yet; lexical check passed
  }
}

function generateId(): string {
  return `p_${randomBytes(4).toString("hex")}`;
}

function seedDefault(): ProjectSet {
  const id = generateId();
  return {
    version: 1,
    activeId: id,
    projects: [
      {
        id,
        name: "default",
        root: process.cwd(),
        pinnedFile: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };
}

function normalizeProjectSet(raw: unknown): ProjectSet {
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as Record<string, unknown>)["version"] !== 1
  ) {
    return seedDefault();
  }
  const r = raw as Record<string, unknown>;
  const rawProjects = Array.isArray(r["projects"]) ? r["projects"] : [];
  const projects: Project[] = [];
  for (const p of rawProjects) {
    if (!p || typeof p !== "object") continue;
    const proj = p as Record<string, unknown>;
    if (
      typeof proj["id"] !== "string" ||
      typeof proj["name"] !== "string" ||
      typeof proj["root"] !== "string" ||
      !isAbsolute(proj["root"] as string)
    ) continue;
    projects.push({
      id: proj["id"] as string,
      name: proj["name"] as string,
      root: proj["root"] as string,
      pinnedFile: typeof proj["pinnedFile"] === "string" ? (proj["pinnedFile"] as string) : null,
      createdAt: typeof proj["createdAt"] === "number" ? (proj["createdAt"] as number) : 0,
      updatedAt: typeof proj["updatedAt"] === "number" ? (proj["updatedAt"] as number) : 0,
    });
  }
  if (projects.length === 0) return seedDefault();
  const rawActiveId = r["activeId"];
  const activeId =
    typeof rawActiveId === "string" && projects.some((p) => p.id === rawActiveId)
      ? rawActiveId
      : projects[0]!.id;
  return { version: 1, activeId, projects };
}

// ---------------------------------------------------------------------------
// Low-level read / write
// ---------------------------------------------------------------------------

export function readProjects(path = DEFAULT_PROJECTS_PATH): ProjectSet {
  if (!existsSync(path)) return seedDefault();
  try {
    return normalizeProjectSet(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return seedDefault();
  }
}

export function writeProjects(path: string, set: ProjectSet): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------

/**
 * Builds the list of allowed base directories from the environment.
 * When MULTI_AGENT_PROJECT_ROOTS is unset, defaults to the parent of cwd
 * (so sibling directories are allowed). The launch cwd is always implicitly
 * included so the initial default project can never be rejected.
 */
export function resolveAllowList(): string[] {
  const cwd = process.cwd();
  const env = process.env["MULTI_AGENT_PROJECT_ROOTS"];
  if (!env) {
    // dirname(cwd) already contains cwd, so siblings are also covered.
    return [dirname(cwd)];
  }
  const bases = env.split(delimiter).map((p) => resolve(p)).filter(Boolean);
  // cwd is always implicitly allowed even when env var is set.
  if (!bases.some((b) => pathContains(b, cwd))) {
    bases.push(cwd);
  }
  return bases;
}

/**
 * Throws if `root` is not under any allowed base directory.
 * Pass an explicit `allowList` to override env resolution (useful in tests).
 */
export function assertWithinAllowList(root: string, allowList?: string[]): void {
  const list = allowList ?? resolveAllowList();
  const absRoot = resolve(root);
  for (const base of list) {
    if (pathContains(base, absRoot)) return;
  }
  throw Object.assign(
    new Error(`root "${root}" is outside allowed base directories`),
    { code: "OUTSIDE_ALLOWLIST" },
  );
}

// ---------------------------------------------------------------------------
// High-level store API  (each function reads then writes atomically from disk)
// ---------------------------------------------------------------------------

export function listProjects(storePath = DEFAULT_PROJECTS_PATH): Project[] {
  return readProjects(storePath).projects;
}

export function getActiveProject(storePath = DEFAULT_PROJECTS_PATH): Project {
  const set = readProjects(storePath);
  const active = set.projects.find((p) => p.id === set.activeId);
  // normalizeProjectSet guarantees activeId always points to a real project.
  return active!;
}

export function addProject(
  opts: { name: string; root: string; pinnedFile?: string | null; allowList?: string[] },
  storePath = DEFAULT_PROJECTS_PATH,
): Project {
  const set = readProjects(storePath);

  const nameLC = opts.name.trim().toLowerCase();
  if (!nameLC) throw new Error("project name must not be empty");
  if (set.projects.some((p) => p.name.toLowerCase() === nameLC)) {
    throw Object.assign(
      new Error(`project name "${opts.name}" is already in use`),
      { code: "DUPLICATE_NAME" },
    );
  }

  const absRoot = resolve(opts.root);
  assertWithinAllowList(absRoot, opts.allowList);

  let pinnedFile: string | null = null;
  if (opts.pinnedFile) {
    pinnedFile = validatePinnedFile(absRoot, opts.pinnedFile);
  }

  const now = Date.now();
  const project: Project = {
    id: generateId(),
    name: opts.name.trim(),
    root: absRoot,
    pinnedFile,
    createdAt: now,
    updatedAt: now,
  };
  set.projects.push(project);
  writeProjects(storePath, set);
  return project;
}

export function setActiveProject(id: string, storePath = DEFAULT_PROJECTS_PATH): void {
  const set = readProjects(storePath);
  if (!set.projects.some((p) => p.id === id)) {
    throw Object.assign(new Error(`project "${id}" not found`), { code: "NOT_FOUND" });
  }
  set.activeId = id;
  writeProjects(storePath, set);
}

export function removeProject(id: string, storePath = DEFAULT_PROJECTS_PATH): void {
  const set = readProjects(storePath);
  if (set.projects.length === 1) {
    throw Object.assign(
      new Error("cannot remove the last project"),
      { code: "LAST_PROJECT" },
    );
  }
  const idx = set.projects.findIndex((p) => p.id === id);
  if (idx === -1) {
    throw Object.assign(new Error(`project "${id}" not found`), { code: "NOT_FOUND" });
  }
  const wasActive = set.activeId === id;
  set.projects.splice(idx, 1);
  if (wasActive) {
    set.activeId = set.projects[0]!.id;
  }
  writeProjects(storePath, set);
}

export function setPinnedFile(
  id: string,
  relPath: string | null,
  storePath = DEFAULT_PROJECTS_PATH,
): void {
  const set = readProjects(storePath);
  const project = set.projects.find((p) => p.id === id);
  if (!project) {
    throw Object.assign(new Error(`project "${id}" not found`), { code: "NOT_FOUND" });
  }
  if (relPath === null) {
    project.pinnedFile = null;
  } else {
    project.pinnedFile = validatePinnedFile(project.root, relPath);
  }
  project.updatedAt = Date.now();
  writeProjects(storePath, set);
}

/**
 * Validates that a root-relative POSIX path stays within the project root.
 * Returns the normalized root-relative POSIX path.
 */
function validatePinnedFile(absRoot: string, relPath: string): string {
  // Convert to POSIX separators and normalize away any ..
  const normalized = posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || isAbsolute(normalized)) {
    throw Object.assign(
      new Error(`pinnedFile "${relPath}" escapes the project root`),
      { code: "TRAVERSAL" },
    );
  }
  return normalized;
}
