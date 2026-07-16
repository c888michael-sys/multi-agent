/**
 * Reject unmistakable orchestration/formatter leakage before it reaches a
 * person. We require multiple signals so legitimate discussion of prompts or
 * agents is not suppressed.
 */
const LEAK_MARKERS = [
  /\bfinal action outputs?\b/i,
  /\b(?:internal|system) (?:prompt|instruction|context)\b/i,
  /\b(?:as the|the) (?:formatter|structural-action|action-structural) agent\b/i,
  /<<<\s*(?:role|action-|reasoning|perception)/i,
  /\bI(?:'ll| will) (?:now )?(?:reformat|preserve|synthesi[sz]e)\b/i,
];

export function finalOutputLeakReason(text: string): string | null {
  const matches = LEAK_MARKERS.filter((marker) => marker.test(text)).length;
  return matches >= 2 ? "model output exposed internal workflow instructions" : null;
}
