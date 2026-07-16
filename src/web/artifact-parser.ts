/** A candidate file extracted from a model response. Validation happens later. */
export interface ArtifactCandidate {
  path: string;
  content: string;
  language?: string;
}

/**
 * Extract file candidates from fenced code blocks. The preferred format is
 * ```language path="relative/file.ext". For backwards compatibility, a
 * leading path comment inside a regular fenced block is also recognised.
 * This parser deliberately performs no security checks: callers must submit
 * candidates to ArtifactService before they can be written.
 */
export function parseArtifactCandidates(text: string): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const header = (match[1] ?? "").trim();
    let content = match[2] ?? "";
    const structured = /(?:^|\s)(?:path|file)\s*=\s*(["'])(.*?)\1/.exec(header);
    const language = header.split(/\s+/, 1)[0] || undefined;
    if (structured?.[2]) {
      candidates.push({ path: structured[2], content, language });
      continue;
    }

    const lines = content.split(/\r?\n/);
    const first = lines[0]?.trim() ?? "";
    const legacy = /^(?:\/\/|#|--|\/\*|<!--)\s*([^*<>\r\n]+?)(?:\s*\*\/|\s*-->)?$/.exec(first);
    if (!legacy?.[1]) continue;
    const path = legacy[1].trim();
    if (!looksLikePath(path)) continue;
    lines.shift();
    content = lines.join("\n");
    candidates.push({ path, content, language });
  }
  return candidates;
}

function looksLikePath(value: string): boolean {
  return value.length > 0 && !/\s/.test(value) && /[/.]/.test(value);
}
