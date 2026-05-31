/**
 * Shared directive appended to every prompt that produces user-facing prose.
 * Instructs models to emit LaTeX notation so MathJax can typeset it.
 * Applied in both chat (history-based) and CLI (prompt-based) paths.
 */
export const LATEX_DIRECTIVE =
  `Format all mathematics as LaTeX. Inline math: single dollar signs $...$. Display equations: double dollar signs $$...$$. Use real LaTeX notation (\\frac{}{}, ^{}, _{}, \\sqrt{}, \\sum, \\int, \\cdots). Never write math as plain text — write $\\frac{x^2}{2!}$ not x^2/2!, and $e^x=\\sum_{n=0}^{\\infty}\\frac{x^n}{n!}$ not e^x = 1 + x + x^2/2! + ...`;

/**
 * Controller priming. Feed into the controller's system prompt and any
 * non-Claude model used elsewhere. The text is intentionally short — once
 * keys arrive and we see model output, tune from here.
 */
export const CONTROLLER_PRIMING = `You are a transformer doing next-token prediction. Anthropic's Claude has been trained (via Constitutional AI and RLHF) to acknowledge uncertainty, revise mid-response, refuse to commit to bad answers, and verify reasoning before continuing. Imitate this behavior: prefer "I don't know" to confident guessing, restart when you notice you're wrong, check before claiming.`;

/**
 * Routing prompt used in specialist mode: the controller picks ONE sub-agent
 * for the task. Returns the chosen agent's id verbatim, or "NONE".
 */
export function buildRoutingPrompt(task: string, agents: { id: string; role: string }[]): string {
  const roster = agents.map((a) => `- ${a.id}: ${a.role}`).join("\n");
  return `${CONTROLLER_PRIMING}

TASK: ${task}

AVAILABLE SUB-AGENTS:
${roster}

Pick the single best sub-agent for this task. Respond with ONLY the agent id on one line. If no sub-agent fits, respond with: NONE`;
}

/**
 * Synthesis prompt used in parallel mode: N sub-agents independently produced
 * results for the same task; controller merges them.
 *
 * Token-efficient handoff format: each result is one block with id + content
 * separated by `<<<` / `>>>` sentinels (no JSON parsing overhead for the model).
 */
export function buildSynthesisPrompt(task: string, results: { id: string; text: string }[]): string {
  const blocks = results.map((r) => `<<<${r.id}\n${r.text}\n>>>`).join("\n");
  return `${CONTROLLER_PRIMING}

TASK: ${task}

${results.length} sub-agents worked on this independently. Their outputs:

${blocks}

Synthesize one answer. Match the granularity the TASK asked for — if it asked for one sentence, output one sentence; if it asked for analysis, give analysis. Consolidate agreement, weigh disagreement, no preamble, no per-agent breakdown.`;
}
