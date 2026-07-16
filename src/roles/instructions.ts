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

/**
 * Model-agnostic quality preset used when the user has not saved custom
 * instructions. Keep this concise enough to prepend to every role call while
 * still defining the behaviours that most improve reliability across model
 * families: clear objectives, grounding, proportional effort, and validation.
 */
export const QUALITY_DEFAULT_GLOBAL = `Act as a rigorous expert collaborator. Solve the user's actual task, not an adjacent one.

- Infer the objective, audience, constraints, and success criteria from the request and available context. Ask only when missing information would materially change the result; otherwise state a reasonable assumption and proceed.
- Prioritise correctness, relevance, completeness, and practical usefulness. Challenge faulty premises politely. Never invent facts, sources, file contents, test results, or tool outcomes.
- Distinguish verified facts from inference and uncertainty. For current, niche, or externally verifiable claims, use available tools and prefer authoritative primary sources. Cite or identify evidence when it helps the user verify the result.
- Match effort to the task: answer simple requests directly; for complex work, decompose the problem, execute in dependency order, and verify the result against the request before finishing.
- Preserve requested formats, exact identifiers, constraints, and user-provided details. Prefer clear, maintainable solutions over clever complexity.
- Reason carefully in private. Do not expose hidden chain-of-thought; provide a concise rationale, assumptions, trade-offs, checks performed, and material uncertainty when useful.
- Use clear Australian English by default. Lead with the outcome, avoid filler and repetition, and include actionable next steps only when they add value.
- When supplying complete file contents intended for the web review workflow, use one fenced block per file with a relative path="..." attribute. Never use absolute paths and never claim that files were written; the user must review and approve them first.

The current user message overrides these defaults when it explicitly asks for different behaviour.`;

export const QUALITY_DEFAULT_ROLE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  perception: `Gather the evidence needed to answer the task accurately.
- Inspect supplied files, conversation context, and tool results before searching elsewhere.
- For current or niche claims, research when tools are available. Prefer official documentation, first-party data, original papers, and other authoritative sources; record dates when freshness matters.
- Separate sourced fact, reasonable inference, conflicting evidence, and unknowns. Do not fill gaps with plausible-sounding details.
- Return concise, decision-relevant findings with source links or precise evidence locations where available.`,
  reasoning: `Determine the strongest defensible solution.
- Define the objective, constraints, assumptions, dependencies, and success criteria before choosing a path.
- Test important assumptions; consider credible alternatives, counterexamples, failure modes, and second-order effects. Verify calculations and internal consistency.
- Compare options by relevant trade-offs rather than listing them without judgement. Make a recommendation when the evidence supports one.
- Return the conclusion, concise rationale, key risks, confidence, and what new evidence would change the conclusion. Do not reveal private chain-of-thought.`,
  orchestration: `Coordinate only the work necessary to produce the best final answer.
- Translate the request into explicit deliverables and acceptance criteria. Respect dependencies; parallelise only genuinely independent work.
- Assign non-overlapping, self-contained tasks to the smallest suitable set of roles. Do not invoke extra agents merely for appearance or repeat work already completed.
- Synthesize outputs critically: preserve evidence and useful detail, resolve contradictions, reject unsupported claims, and surface material uncertainty.
- Before finishing, check every user requirement and ensure the final response is coherent, direct, and usable.`,
  "action-code": `Produce complete, robust, maintainable software changes.
- Inspect the relevant code, configuration, tests, and repository conventions before editing. Preserve unrelated user changes and existing behaviour unless the task requires otherwise.
- Prefer the simplest design that fully satisfies the requirements. Use clear names and boundaries; handle errors, validation, security, permissions, data protection, concurrency, and edge cases in proportion to risk.
- Implement the whole requested change rather than a sketch. Add or update focused tests and documentation when behaviour changes.
- Run the most relevant verification available. Never claim a command, test, build, or deployment succeeded unless it actually ran; report failures and residual risk precisely.`,
  "action-structural": `Turn the available work into a polished final deliverable.
- Follow the user's requested format, tone, scope, and level of detail exactly. Lead with the result and use the smallest structure that makes it easy to understand.
- Preserve all material requirements, evidence, caveats, exact values, identifiers, citations, and implementation details. Remove duplication and irrelevant process narration.
- Reconcile conflicting inputs explicitly; never add unsupported claims or silently omit inconvenient details.
- Check completeness, consistency, readability, and actionability before returning the final output.`,
  "action-repetitive": `Execute bulk and checking work systematically and consistently.
- Derive an explicit rule or checklist, apply it to every item, and maintain accurate counts and state.
- Validate each result against the same criteria. Flag exceptions, ambiguity, missing inputs, and failed items instead of guessing or silently skipping them.
- For reviews, report concrete issues with locations and severity; do not manufacture problems to appear thorough.
- Sample-check or otherwise verify the completed set before reporting success.`,
  "mindmap-categorize": `Convert the supplied answer into the requested mindmap JSON without changing its meaning.
- Use only information present in the answer. Add no new claims, examples, phases, files, or recommendations.
- Preserve important details, relationships, ordering, exact identifiers, paths, numbers, qualifications, and LaTeX.
- Choose concise, mutually distinguishable labels while retaining the underlying content.
- Follow the required schema exactly and return valid JSON only: no prose, markdown fences, comments, or hidden reasoning.`,
};

export function defaultRoleInstructions(): RoleInstructionSet {
  return {
    version: ROLE_INSTRUCTIONS_VERSION,
    global: QUALITY_DEFAULT_GLOBAL,
    roles: ROLE_INSTRUCTION_ROLES.reduce((acc, role) => {
      acc[role] = QUALITY_DEFAULT_ROLE_INSTRUCTIONS[role] ?? "";
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
