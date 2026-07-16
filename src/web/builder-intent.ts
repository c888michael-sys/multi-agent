import { detectBuilderQualityProfile, type BuilderQualityProfile } from "./builder-quality.js";

/**
 * Conservative, deterministic routing for requests that should create
 * reviewable project files. This is deliberately independent of model output:
 * the server uses it as the authority and the browser may mirror it only for
 * a pre-submit hint.
 */
export type BuilderMode = "auto" | "always" | "off";
export type BuilderSource = "auto" | "always";

export interface BuilderDecision {
  active: boolean;
  source?: BuilderSource;
  /** A create/modify request must stage at least one file before succeeding. */
  requiresStagedFile: boolean;
  /** Standalone build requests should not inherit unrelated chat topics. */
  historyScope: "session" | "turn";
  reason?: string;
  /** Stricter completion contract for genuinely open-ended creative work. */
  qualityProfile?: BuilderQualityProfile;
}

export interface BuilderIntentInput {
  mode?: BuilderMode;
  /** Backwards-compatible API field. New callers should send mode. */
  legacyBuilder?: boolean;
  /** The raw composer text, without attachment bodies. */
  intentText: string;
  forceRole?: string | null;
}

const CREATE_VERB = /\b(build|create|make|develop|implement|scaffold|generate|set\s+up)\b/i;
const BUILD_ARTIFACT = /\b(?:website|web\s*site|web\s*app(?:lication)?|landing\s*page|dashboard|portfolio(?:\s*site)?|static\s*site|frontend\s*project|(?:html|css|javascript|typescript|react|next(?:\.js)?)\s*(?:project|app|site))\b/i;
const FILE_ARTIFACT = /\b[\w.-]+\.(?:html?|css|jsx?|tsx?|vue|svelte|py|go|rs|java)\b/i;
const EXPLANATORY = /\b(?:how\s+(?:do|can|would)|explain|teach|learn|plan|spec(?:ification)?|review|critique|describe|brainstorm|idea)\b/i;
const NEGATED = /\b(?:do\s+not|don't|never)\s+(?:build|create|make|develop|implement|scaffold|generate|set\s+up)\b/i;
const CONTINUATION = /\b(?:above|previous|earlier|our\s+(?:chat|conversation|discussion)|this\s+(?:site|app|project|design)|that\s+(?:site|app|project|design)|continue|update|change|modify)\b/i;

export function normalizeBuilderMode(mode: unknown, legacyBuilder?: boolean): BuilderMode {
  if (mode === "auto" || mode === "always" || mode === "off") return mode;
  if (legacyBuilder === true) return "always";
  if (legacyBuilder === false) return "off";
  return "auto";
}

export function resolveBuilderIntent(input: BuilderIntentInput): BuilderDecision {
  const mode = normalizeBuilderMode(input.mode, input.legacyBuilder);
  const text = input.intentText.trim();
  const hasCreationIntent =
    text.length > 0 &&
    CREATE_VERB.test(text) &&
    (BUILD_ARTIFACT.test(text) || FILE_ARTIFACT.test(text)) &&
    !EXPLANATORY.test(text) &&
    !NEGATED.test(text);
  const historyScope: BuilderDecision["historyScope"] = CONTINUATION.test(text) ? "session" : "turn";
  const qualityProfile = detectBuilderQualityProfile(text, hasCreationIntent);

  if (mode === "off") {
    return { active: false, requiresStagedFile: false, historyScope, reason: "disabled" };
  }
  if (mode === "always") {
    return {
      active: true,
      source: "always",
      requiresStagedFile: hasCreationIntent,
      historyScope,
      reason: hasCreationIntent ? "explicit creation request" : "always enabled",
      ...(qualityProfile ? { qualityProfile } : {}),
    };
  }
  // A deliberately pinned non-code role is an explicit request for prose or
  // analysis. Auto mode respects it; users can still choose Builder always.
  if (input.forceRole && input.forceRole !== "auto" && input.forceRole !== "action-code") {
    return { active: false, requiresStagedFile: false, historyScope, reason: "explicit role" };
  }
  if (!hasCreationIntent) {
    return { active: false, requiresStagedFile: false, historyScope, reason: "no file-producing intent" };
  }
  return {
    active: true,
    source: "auto",
    requiresStagedFile: true,
    historyScope,
    reason: "file-producing build request",
    ...(qualityProfile ? { qualityProfile } : {}),
  };
}
