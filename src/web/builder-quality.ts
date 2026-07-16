import { Buffer } from "node:buffer";
import type { ArtifactCandidate } from "./artifact-parser.js";

export type BuilderQualityProfile = "creative-web";

export interface InferredBuildBrief {
  concept: string;
  audience: string;
  visualDirection: string;
  sections: string[];
  interactions: string[];
  successCriteria: string[];
}

export interface BuilderQualityCheck {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
}

export interface BuilderQualitySnapshot {
  profile: BuilderQualityProfile;
  passed: boolean;
  brief?: InferredBuildBrief;
  checks: BuilderQualityCheck[];
}

const OPEN_ENDED_CREATIVE = /\b(?:of your choice|showcase (?:your|the) skill|show what you can do|surprise me|impress me|be creative|go all out|make it amazing)\b/i;
const EXPLICITLY_SMALL = /\b(?:simple|minimal|basic|bare[- ]?bones|single[- ]file|quick prototype|wireframe|skeleton|unstyled)\b/i;
const SPECIFIC_DIRECTION = /\b(?:for (?:my|our|a|an|the)|audience|brand|style|theme|colour|color|include|featuring|with (?:a|an|the)|using|must|should|sections?|features?|content|copy|framework|react|vue|svelte)\b/i;

/** Select a stricter quality contract only when creative freedom is genuine. */
export function detectBuilderQualityProfile(text: string, hasCreationIntent: boolean): BuilderQualityProfile | undefined {
  if (!hasCreationIntent || EXPLICITLY_SMALL.test(text)) return undefined;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const underspecified = words <= 8 && !SPECIFIC_DIRECTION.test(text);
  return OPEN_ENDED_CREATIVE.test(text) || underspecified ? "creative-web" : undefined;
}

function cleanText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanList(value: unknown, maxItems: number): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|\s*;\s*/)
      : [];
  return items.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, maxItems);
}

export function parseInferredBuildBrief(args: Record<string, unknown>): { brief?: InferredBuildBrief; errors: string[] } {
  const brief: InferredBuildBrief = {
    concept: cleanText(args.concept),
    audience: cleanText(args.audience, 240),
    visualDirection: cleanText(args.visualDirection),
    sections: cleanList(args.sections, 12),
    interactions: cleanList(args.interactions, 8),
    successCriteria: cleanList(args.successCriteria, 10),
  };
  const errors: string[] = [];
  if (brief.concept.length < 20) errors.push("concept must be a concrete creative direction (20+ characters)");
  if (brief.audience.length < 8) errors.push("audience must identify who the site is for");
  if (brief.visualDirection.length < 20) errors.push("visualDirection must describe a deliberate visual system");
  if (brief.sections.length < 4) errors.push("sections must contain at least four meaningful content areas");
  if (brief.interactions.length < 1) errors.push("interactions must contain at least one purposeful interaction");
  if (brief.successCriteria.length < 3) errors.push("successCriteria must contain at least three reviewable outcomes");
  return errors.length ? { errors } : { brief, errors };
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

export function evaluateCreativeWebQuality(
  brief: InferredBuildBrief | undefined,
  candidates: ArtifactCandidate[],
): BuilderQualitySnapshot {
  const markup = candidates
    .filter((file) => /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const styles = candidates
    .filter((file) => /\.(?:css|scss|sass|less)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const scripts = candidates
    .filter((file) => /\.(?:js|jsx|ts|tsx|vue|svelte)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const inlineScripts = markup.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi)?.join("\n") ?? "";
  const scriptSource = `${scripts}\n${inlineScripts}`;
  const all = candidates.map((file) => file.content).join("\n");
  const lower = all.toLowerCase();
  const totalBytes = candidates.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  const semanticElements = count(markup, /<(?:header|nav|main|section|article|aside|footer)\b/gi);
  const headings = count(markup, /<h[1-6]\b/gi);
  const cssSignals = count(all, /\b(?:display|grid-template|font-family|background|color|padding|margin|gap|border|transform|transition|animation)\s*:/gi);
  const utilityClassSignals = count(all, /\b(?:grid|flex|gap-\d|p[xy]?-\d|m[xy]?-\d|bg-[\w-]+|text-[\w-]+|rounded[\w-]*)\b/g);
  const accessibilitySignals = [
    /<html[^>]+lang=/i,
    /name=["']viewport["']/i,
    /\baria-[\w-]+=/i,
    /\balt=["'][^"']+/i,
    /:focus(?:-visible)?/i,
    /<label\b/i,
  ].filter((pattern) => pattern.test(all)).length;
  const placeholders = /\b(?:lorem ipsum|coming soon|todo:|your (?:company|name|text) here|replace this text)\b/i.test(lower);

  const checks: BuilderQualityCheck[] = [
    {
      id: "brief",
      label: "Concrete inferred brief",
      passed: !!brief,
      evidence: brief ? `${brief.sections.length} sections, ${brief.interactions.length} interaction(s)` : "define_build_brief has not succeeded",
    },
    {
      id: "substance",
      label: "Substantive implementation",
      passed: totalBytes >= 6_000 && markup.length >= 2_200,
      evidence: `${totalBytes} total bytes; ${markup.length} markup characters`,
    },
    {
      id: "content-depth",
      label: "Meaningful content structure",
      passed: semanticElements >= 6 && headings >= 3,
      evidence: `${semanticElements} semantic regions; ${headings} headings`,
    },
    {
      id: "visual-system",
      label: "Deliberate visual system",
      passed: styles.length >= 1_500 || cssSignals >= 12 || utilityClassSignals >= 20,
      evidence: `${styles.length} stylesheet characters; ${cssSignals} CSS signals; ${utilityClassSignals} utility-class signals`,
    },
    {
      id: "responsive",
      label: "Responsive behaviour",
      passed: /name=["']viewport["']/i.test(markup) && /@media|clamp\(|minmax\(|auto-(?:fit|fill)|container-type|(?:sm|md|lg|xl):/i.test(all),
      evidence: "viewport metadata plus responsive CSS evidence required",
    },
    {
      id: "interaction",
      label: "Purposeful interaction",
      passed: scriptSource.length >= 250 && /addEventListener|onClick|onSubmit|IntersectionObserver|requestAnimationFrame|classList\.(?:add|remove|toggle)|onclick\s*=/i.test(scriptSource),
      evidence: `${scriptSource.length} script characters with an event/interaction handler required`,
    },
    {
      id: "accessibility",
      label: "Accessibility foundations",
      passed: accessibilitySignals >= 3,
      evidence: `${accessibilitySignals} distinct accessibility signals`,
    },
    {
      id: "finished-copy",
      label: "Finished, non-placeholder copy",
      passed: !placeholders,
      evidence: placeholders ? "placeholder or unfinished copy detected" : "no unfinished-copy markers detected",
    },
  ];
  return { profile: "creative-web", passed: checks.every((check) => check.passed), ...(brief ? { brief } : {}), checks };
}
