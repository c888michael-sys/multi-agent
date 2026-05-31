import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RoleName } from "./types.js";

export const ROLE_INSTRUCTIONS_VERSION = 1;
export const DEFAULT_ROLE_INSTRUCTIONS_PATH = join(
  homedir(),
  ".multi-agent",
  "role-instructions.json",
);

export const ROLE_INSTRUCTION_ROLES: readonly RoleName[] = [
  "perception",
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
  "mindmap-categorize",
];

export type RoleInstructionRoles = Record<RoleName, string>;

export interface RoleInstructionSet {
  version: 1;
  /** Applies to every role call. */
  global: string;
  /** Applies only to the named role. Empty strings mean no override. */
  roles: RoleInstructionRoles;
}

export type RoleInstructionInput = {
  version?: unknown;
  global?: unknown;
  roles?: Partial<Record<RoleName, unknown>> | Record<string, unknown> | null;
};

export function defaultRoleInstructions(): RoleInstructionSet {
  return {
    version: ROLE_INSTRUCTIONS_VERSION,
    global: "",
    roles: ROLE_INSTRUCTION_ROLES.reduce((acc, role) => {
      acc[role] = "";
      return acc;
    }, {} as RoleInstructionRoles),
  };
}

export function normalizeRoleInstructions(input: unknown): RoleInstructionSet {
  const defaults = defaultRoleInstructions();
  if (!input || typeof input !== "object") return defaults;

  const raw = input as RoleInstructionInput;
  const roles = { ...defaults.roles };
  const rawRoles =
    raw.roles && typeof raw.roles === "object" && !Array.isArray(raw.roles)
      ? raw.roles
      : {};

  for (const role of ROLE_INSTRUCTION_ROLES) {
    const value = rawRoles[role];
    roles[role] = typeof value === "string" ? value : "";
  }

  return {
    version: ROLE_INSTRUCTIONS_VERSION,
    global: typeof raw.global === "string" ? raw.global : "",
    roles,
  };
}

export function readRoleInstructions(
  path = DEFAULT_ROLE_INSTRUCTIONS_PATH,
): RoleInstructionSet {
  if (!existsSync(path)) return defaultRoleInstructions();
  try {
    return normalizeRoleInstructions(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultRoleInstructions();
  }
}

export function writeRoleInstructions(
  path: string,
  input: unknown,
): RoleInstructionSet {
  const normalized = normalizeRoleInstructions(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function formatRoleInstructionsForRole(
  role: RoleName,
  instructions?: unknown,
): string {
  if (!instructions) return "";
  const normalized = normalizeRoleInstructions(instructions);
  const global = normalized.global.trim();
  const roleText = normalized.roles[role]?.trim() ?? "";
  if (!global && !roleText) return "";

  const sections: string[] = [
    `[Long-term role instructions for ${role}. These are local user preferences from the web settings role-instructions file. Follow them unless the current user message explicitly overrides them.]`,
  ];
  if (global) sections.push(`Global instructions:\n${global}`);
  if (roleText) sections.push(`Role-specific instructions for ${role}:\n${roleText}`);
  return sections.join("\n\n");
}
