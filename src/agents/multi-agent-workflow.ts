import type { RoleName } from "../roles/types.js";

export type RoutingMode = "auto" | "multi-agent" | "brainstorming";

export type ActionRoleName = Extract<
  RoleName,
  "action-code" | "action-structural" | "action-repetitive"
>;

export interface MultiAgentPlan {
  needsResearch: boolean;
  researchPrompt: string;
  actions: { role: ActionRoleName; prompt: string }[];
  useChecker: boolean;
  checkerPrompt: string;
  maxRepairAttempts: number;
}

export interface WorkflowRoleOutput {
  role: RoleName;
  output: string;
}

export interface WorkflowTrace {
  plan: MultiAgentPlan;
  perRole: WorkflowRoleOutput[];
  finalOutput: string;
  servedBy: RoleName[];
}

export type WorkflowPhase =
  | "planning"
  | "research"
  | "action"
  | "check"
  | "repair"
  | "format"
  | "synthesis";

export type WorkflowProgress =
  | { kind: "plan-start" }
  | { kind: "plan"; plan: { kind: "multi-agent"; detail: MultiAgentPlan } }
  | { kind: "role-start"; role: RoleName; phase: WorkflowPhase; framing?: string }
  | { kind: "role-end"; role: RoleName; ok: boolean; error?: string }
  | { kind: "token"; text: string };

export interface WorkflowRuntime {
  runRole(role: RoleName, prompt: string): Promise<string>;
  streamRole?(
    role: RoleName,
    prompt: string,
    onToken: (text: string) => void,
  ): Promise<string>;
  onProgress?: (evt: WorkflowProgress) => void;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

const ALLOWED_ACTION_ROLES = new Set<ActionRoleName>([
  "action-code",
  "action-structural",
  "action-repetitive",
]);

export function brainstormingTasks(task: string): { role: RoleName; prompt: string }[] {
  const tasks: { role: RoleName; prompt: string }[] = [
    {
      role: "perception",
      prompt:
        "Give a research-based perspective. Prioritize facts, evidence, sources, market/context signals, and current information when search/browsing is enabled. Avoid vibes-only opinion.",
    },
    {
      role: "reasoning",
      prompt:
        "Give the strategic/logic perspective. Identify assumptions, tradeoffs, risks, and the strongest line of reasoning.",
    },
    {
      role: "action-code",
      prompt:
        "Give the implementation perspective. Focus on how this would be built, automated, debugged, or made concrete.",
    },
    {
      role: "action-structural",
      prompt:
        "Give the structure/presentation perspective. Focus on organization, clarity, formatting, and how the answer should be arranged for the user.",
    },
  ];
  return tasks.map((t) => ({
    ...t,
    prompt: `${t.prompt}\n\nUser task:\n${task}`,
  }));
}

export function parseMultiAgentPlan(raw: string, task: string): MultiAgentPlan {
  const fallback: MultiAgentPlan = {
    needsResearch: false,
    researchPrompt: "",
    actions: [{ role: "action-structural", prompt: task }],
    useChecker: false,
    checkerPrompt: "",
    maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS,
  };

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const p = parsed as Record<string, unknown>;
  const actions: { role: ActionRoleName; prompt: string }[] = [];
  if (Array.isArray(p.actions)) {
    for (const item of p.actions) {
      if (typeof item !== "object" || item === null) continue;
      const a = item as Record<string, unknown>;
      if (
        typeof a.role === "string" &&
        ALLOWED_ACTION_ROLES.has(a.role as ActionRoleName) &&
        typeof a.prompt === "string"
      ) {
        actions.push({ role: a.role as ActionRoleName, prompt: a.prompt });
      }
    }
  }

  const maxRepairAttempts =
    typeof p.maxRepairAttempts === "number" && Number.isFinite(p.maxRepairAttempts)
      ? Math.max(0, Math.min(3, Math.floor(p.maxRepairAttempts)))
      : DEFAULT_MAX_REPAIR_ATTEMPTS;

  return {
    needsResearch: p.needsResearch === true,
    researchPrompt: typeof p.researchPrompt === "string" ? p.researchPrompt : "",
    actions: actions.length > 0 ? actions : fallback.actions,
    useChecker: p.useChecker === true,
    checkerPrompt: typeof p.checkerPrompt === "string" ? p.checkerPrompt : "",
    maxRepairAttempts,
  };
}

export function parseCheckResult(raw: string): { ok: boolean; issues: string } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const status = String(parsed.status ?? "").toLowerCase();
    const issueList = Array.isArray(parsed.issues)
      ? parsed.issues.map((x) => String(x)).filter(Boolean)
      : [];
    const issues =
      issueList.length > 0
        ? issueList.join("\n")
        : typeof parsed.summary === "string"
          ? parsed.summary
          : raw;
    if (status === "ok" || status === "pass" || status === "clean") return { ok: true, issues };
    if (status === "issues" || status === "fail" || issueList.length > 0) {
      return { ok: false, issues };
    }
  } catch {
    // Fall through to conservative text heuristics below.
  }

  const lower = raw.toLowerCase();
  if (/\b(no issues|looks good|pass|ok|clean)\b/.test(lower) && !/\b(issue|bug|error|fail)\b/.test(lower)) {
    return { ok: true, issues: raw };
  }
  return { ok: false, issues: raw };
}

export async function runMultiAgentWorkflow(
  task: string,
  runtime: WorkflowRuntime,
): Promise<WorkflowTrace> {
  const fire = runtime.onProgress ?? (() => {});
  const perRole: WorkflowRoleOutput[] = [];
  const servedBy: RoleName[] = [];

  fire({ kind: "plan-start" });
  fire({ kind: "role-start", role: "reasoning", phase: "planning" });
  const planRaw = await runtime.runRole("reasoning", buildPlanningPrompt(task));
  fire({ kind: "role-end", role: "reasoning", ok: true });
  servedBy.push("reasoning");
  perRole.push({ role: "reasoning", output: planRaw });

  const plan = parseMultiAgentPlan(planRaw, task);
  fire({ kind: "plan", plan: { kind: "multi-agent", detail: plan } });

  let research = "";
  if (plan.needsResearch) {
    const prompt = plan.researchPrompt.trim() || `Research the user task and return concise findings.\n\n${task}`;
    fire({ kind: "role-start", role: "perception", phase: "research", framing: prompt });
    research = await runtime.runRole("perception", prompt);
    fire({ kind: "role-end", role: "perception", ok: true });
    servedBy.push("perception");
    perRole.push({ role: "perception", output: research });
  }

  let actionOutputs = await runActions(runtime, plan.actions, task, research, undefined, fire);
  servedBy.push(...actionOutputs.map((o) => o.role));
  perRole.push(...actionOutputs);

  if (plan.useChecker) {
    const max = plan.maxRepairAttempts;
    for (let attempt = 0; attempt <= max; attempt++) {
      const checkPrompt = buildCheckPrompt(task, plan, research, actionOutputs);
      fire({ kind: "role-start", role: "action-repetitive", phase: "check", framing: plan.checkerPrompt });
      const checkRaw = await runtime.runRole("action-repetitive", checkPrompt);
      fire({ kind: "role-end", role: "action-repetitive", ok: true });
      servedBy.push("action-repetitive");
      perRole.push({ role: "action-repetitive", output: checkRaw });

      const check = parseCheckResult(checkRaw);
      if (check.ok || attempt >= max) break;

      fire({ kind: "role-start", role: "reasoning", phase: "repair", framing: check.issues });
      const repairPlan = await runtime.runRole("reasoning", buildRepairPrompt(task, actionOutputs, check.issues));
      fire({ kind: "role-end", role: "reasoning", ok: true });
      servedBy.push("reasoning");
      perRole.push({ role: "reasoning", output: repairPlan });

      actionOutputs = await runActions(runtime, plan.actions, task, research, repairPlan, fire);
      servedBy.push(...actionOutputs.map((o) => o.role));
      perRole.push(...actionOutputs);
    }
  }

  const formatPrompt = buildFormatPrompt(task, research, actionOutputs);
  fire({ kind: "role-start", role: "action-structural", phase: "format" });
  const finalOutput = runtime.streamRole
    ? await runtime.streamRole("action-structural", formatPrompt, (text) => fire({ kind: "token", text }))
    : await runtime.runRole("action-structural", formatPrompt);
  if (!runtime.streamRole) fire({ kind: "token", text: finalOutput });
  fire({ kind: "role-end", role: "action-structural", ok: true });
  servedBy.push("action-structural");
  perRole.push({ role: "action-structural", output: finalOutput });

  return { plan, perRole, finalOutput, servedBy };
}

async function runActions(
  runtime: WorkflowRuntime,
  actions: MultiAgentPlan["actions"],
  task: string,
  research: string,
  repairPlan: string | undefined,
  fire: (evt: WorkflowProgress) => void,
): Promise<WorkflowRoleOutput[]> {
  const settled = await Promise.all(
    actions.map(async (action) => {
      const prompt = buildActionPrompt(task, action.prompt, research, repairPlan);
      fire({ kind: "role-start", role: action.role, phase: "action", framing: action.prompt });
      const output = await runtime.runRole(action.role, prompt);
      fire({ kind: "role-end", role: action.role, ok: true });
      return { role: action.role, output };
    }),
  );
  return settled;
}

function buildPlanningPrompt(task: string): string {
  return `You are the reasoning planner for a sequential multi-agent workflow.

Decide whether this task needs research, which action role(s) should execute it, and whether action-repetitive should check the result. Use the checker for coding/debugging, risky changes, multi-step work, or when mistakes would be costly. Skip it for tiny/simple conversational answers.

Output EXACTLY this JSON shape:
{
  "needsResearch": true|false,
  "researchPrompt": "<prompt for perception, or empty string>",
  "actions": [
    { "role": "action-code"|"action-structural"|"action-repetitive", "prompt": "<self-contained action prompt>" }
  ],
  "useChecker": true|false,
  "checkerPrompt": "<what action-repetitive should verify, or empty string>",
  "maxRepairAttempts": 0|1|2
}

User task:
${task}`;
}

function buildActionPrompt(
  task: string,
  actionPrompt: string,
  research: string,
  repairPlan: string | undefined,
): string {
  return `User task:
${task}

${research ? `Research/context from perception:\n${research}\n\n` : ""}${repairPlan ? `Repair plan from reasoning:\n${repairPlan}\n\n` : ""}Your assigned action:
${actionPrompt}`;
}

function buildCheckPrompt(
  task: string,
  plan: MultiAgentPlan,
  research: string,
  actionOutputs: WorkflowRoleOutput[],
): string {
  return `You are the checker. Look for bugs, errors, missing requirements, contradictions, or formatting-breaking issues.

User task:
${task}

Checker focus:
${plan.checkerPrompt || "Verify whether the action output fully satisfies the user task."}

${research ? `Research/context:\n${research}\n\n` : ""}Action outputs:
${actionOutputs.map((o) => `<<<${o.role}\n${o.output}\n>>>`).join("\n\n")}

Output EXACTLY JSON:
{ "status": "ok"|"issues", "issues": ["..."], "summary": "..." }`;
}

function buildRepairPrompt(
  task: string,
  actionOutputs: WorkflowRoleOutput[],
  issues: string,
): string {
  return `The checker found issues in the latest action output. Create a concise repair plan for the action model(s).

User task:
${task}

Issues:
${issues}

Previous action outputs:
${actionOutputs.map((o) => `<<<${o.role}\n${o.output}\n>>>`).join("\n\n")}

Output only the repair instructions.`;
}

function buildFormatPrompt(
  task: string,
  research: string,
  actionOutputs: WorkflowRoleOutput[],
): string {
  return `Reformat the final answer for the user. This is visual/structural only: preserve meaning and details, do not omit important content, and do not introduce new claims.

User task:
${task}

${research ? `Research/context:\n${research}\n\n` : ""}Final action outputs:
${actionOutputs.map((o) => `<<<${o.role}\n${o.output}\n>>>`).join("\n\n")}`;
}
