// hero-mindmap-templates.jsx
// Template defs (detect + system prompt + renderer) for the dynamic mindmap flow.
// Each template's renderer takes the parsed `data` object and renders a "burst" view:
// a central node (the prompt) connected to section cards radiating outward, each with
// its own copy button. Renderers share visual scaffolding via `<MMNode>` helpers.

// ─── Detection & schemas ─────────────────────────────────────
const TEMPLATE_KEYS = ['research', 'code', 'compare', 'plan'];

const TEMPLATE_DEFS = {
  research: {
    label: 'Research',
    accent: 'oklch(0.82 0.14 230)',
    detect: (p) =>
      /\b(research|find|sources?|study|history|what is|why|how does|explain|origin|background|definition)\b/i.test(p),
    prompt: (q) =>
      `Answer this user request as RESEARCH. Return ONLY valid JSON, no prose. Schema:
{"type":"research","summary":"<1-2 sentence overview>","sections":[
  {"heading":"<short heading>","points":["<short point>"],"sources":[{"title":"<short>","url":"<url or 'general knowledge'>"}]}
]}
3-5 sections. Each section: 2-4 points, 1-3 sources. Keep all strings under 90 chars.

User: ${q}`,
  },
  code: {
    label: 'Code',
    accent: 'oklch(0.85 0.10 195)',
    detect: (p) =>
      /\b(code|implement|build a|function|class|refactor|cli|api|module|component|script)\b/i.test(p),
    prompt: (q) =>
      `Answer this user request as a CODE skeleton. Return ONLY valid JSON, no prose. Schema:
{"type":"code","summary":"<1-2 sentence overview>","files":[
  {"name":"<filename>","language":"<lang>","snippet":"<short representative code, <=10 lines, escape newlines as \\n>","notes":["<short>"]}
]}
3-5 files. Snippet must be short and representative.

User: ${q}`,
  },
  compare: {
    label: 'Compare',
    accent: 'oklch(0.78 0.10 280)',
    detect: (p) =>
      /\b(compare|vs\.?|versus|best|differences? between|rank|which is better|tradeoffs?)\b/i.test(p),
    prompt: (q) =>
      `Answer this user request as a COMPARISON. Return ONLY valid JSON, no prose. Schema:
{"type":"compare","summary":"<short overview>","ranking":[
  {"name":"<>","rank":<1-based>,"score":<0-10 number>,"takeaway":"<short>"}
],"targets":[
  {"name":"<must match a name in ranking>","pros":["<>"],"cons":["<>"],"reason":"<one-sentence reason for rank>"}
]}
2-4 targets. Each target: 2-3 pros, 2-3 cons.

User: ${q}`,
  },
  plan: {
    label: 'Plan',
    accent: 'oklch(0.86 0.08 215)',
    detect: () => true, // fallback
    prompt: (q) =>
      `Answer this user request as a PLAN. Return ONLY valid JSON, no prose. Schema:
{"type":"plan","summary":"<short overview>","phases":[
  {"title":"<short>","steps":["<short>"]}
]}
3-5 phases, 2-4 steps each.

User: ${q}`,
  },
};

function detectTemplate(prompt) {
  for (const k of TEMPLATE_KEYS) {
    if (k !== 'plan' && TEMPLATE_DEFS[k].detect(prompt)) return k;
  }
  return 'plan';
}

// Fallback data per template if Claude returns nothing parseable.
const FALLBACK_DATA = {
  research: {
    type: 'research',
    summary: 'Quick overview of the topic with key facets and references.',
    sections: [
      { heading: 'Background', points: ['Origin and context', 'Why it matters'], sources: [{ title: 'Overview source', url: '#' }] },
      { heading: 'Core ideas', points: ['Primary concept', 'Common misconception'], sources: [{ title: 'Reference paper', url: '#' }] },
      { heading: 'Related work', points: ['Adjacent fields', 'Open questions'], sources: [{ title: 'Survey', url: '#' }] },
    ],
  },
  code: {
    type: 'code',
    summary: 'Project skeleton with entry point and supporting modules.',
    files: [
      { name: 'src/main.ts', language: 'typescript', snippet: 'function main() {\n  // entry point\n  console.log("hello");\n}', notes: ['Entry point'] },
      { name: 'src/lib.ts', language: 'typescript', snippet: 'export function helper() {\n  return 42;\n}', notes: ['Shared helpers'] },
      { name: 'README.md', language: 'markdown', snippet: '# Project\n\nDocs go here.', notes: ['Project docs'] },
    ],
  },
  compare: {
    type: 'compare',
    summary: 'A side-by-side look at the options.',
    ranking: [
      { name: 'Option A', rank: 1, score: 8.4, takeaway: 'Strongest overall' },
      { name: 'Option B', rank: 2, score: 7.1, takeaway: 'Best for niche use' },
    ],
    targets: [
      { name: 'Option A', pros: ['Maturity', 'Ecosystem'], cons: ['Cost', 'Lock-in'], reason: 'Wins on breadth and reliability.' },
      { name: 'Option B', pros: ['Cheaper', 'Lightweight'], cons: ['Smaller community'], reason: 'Excellent for focused use-cases.' },
    ],
  },
  plan: {
    type: 'plan',
    summary: 'A staged plan with concrete next steps.',
    phases: [
      { title: 'Prepare', steps: ['Define success', 'Set baselines'] },
      { title: 'Execute', steps: ['Build MVP', 'Ship to 10 users'] },
      { title: 'Learn', steps: ['Collect feedback', 'Iterate weekly'] },
    ],
  },
};

// ─── Helpers ─────────────────────────────────────────────────
function copyText(t) {
  try { navigator.clipboard.writeText(t); } catch (e) {}
}

function CopyButton({ getText, tiny }) {
  const [hit, setHit] = React.useState(false);
  return (
    <button
      className={'mm-copy ' + (tiny ? 'tiny' : '')}
      onClick={(e) => {
        e.stopPropagation();
        copyText(getText());
        setHit(true);
        setTimeout(() => setHit(false), 1100);
      }}
      title="Copy"
    >
      {hit ? (
        <svg viewBox="0 0 12 12"><path d="M3 6.2 5.2 8.5 9.5 3.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
          <path d="M5.5 3.5V2.5h-3v3h1" />
        </svg>
      )}
      {!tiny && <span>{hit ? 'copied' : 'copy'}</span>}
    </button>
  );
}

function deriveMindmapData(template, prompt, answer) {
  const sections = markdownSections(answer);
  const summary = firstCleanLine(answer) || 'Categorized view of the response.';

  if (template === 'code') {
    const fences = extractCodeFences(answer);
    const files = fences.length > 0
      ? fences.slice(0, 6).map((f, i) => ({
          name: f.name || `snippet-${i + 1}.${langExt(f.language)}`,
          language: f.language || 'text',
          snippet: f.code,
          notes: [sectionForIndex(sections, i)?.heading || 'Code from the response'],
        }))
      : sections.map((s, i) => ({
          name: slugName(s.heading || `part-${i + 1}`) + '.md',
          language: 'markdown',
          snippet: s.body.slice(0, 700),
          notes: sectionPoints(s.body, 2),
        }));
    return { type: 'code', summary, files: clampItems(files, 2, 6, FALLBACK_DATA.code.files) };
  }

  if (template === 'compare') {
    const names = comparisonNames(prompt, answer, sections);
    const targets = names.map((name, i) => {
      const sec = sections.find((s) => s.heading.toLowerCase().includes(name.toLowerCase())) || sections[i] || sections[0];
      const pts = sectionPoints(sec?.body || answer, 5);
      return {
        name,
        pros: pts.slice(0, Math.max(1, Math.ceil(pts.length / 2))),
        cons: pts.slice(Math.max(1, Math.ceil(pts.length / 2)), 5),
        reason: cleanText(sec?.heading && sec.heading !== name ? sec.heading : (pts[0] || `${name} discussed in the response.`)),
      };
    });
    const ranking = targets.map((t, i) => ({
      name: t.name,
      rank: i + 1,
      score: Math.max(6, 9 - i * 0.6),
      takeaway: t.reason,
    }));
    return { type: 'compare', summary, ranking, targets };
  }

  if (template === 'research') {
    const mapped = sections.map((s) => ({
      heading: cleanHeading(s.heading),
      points: sectionPoints(s.body, 4),
      sources: extractSources(s.body),
    }));
    return { type: 'research', summary, sections: clampItems(mapped, 2, 6, FALLBACK_DATA.research.sections) };
  }

  const phases = sections.map((s) => ({
    title: cleanHeading(s.heading),
    steps: sectionPoints(s.body, 4),
  }));
  return { type: 'plan', summary, phases: clampItems(phases, 2, 6, FALLBACK_DATA.plan.phases) };
}

function markdownSections(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  const headingRe = /^(#{1,4})\s+(.+)$/gm;
  const hits = [...raw.matchAll(headingRe)];
  if (hits.length > 1) {
    return hits.slice(0, 6).map((m, i) => {
      const start = (m.index || 0) + m[0].length;
      const end = i + 1 < hits.length ? (hits[i + 1].index || raw.length) : raw.length;
      return { heading: cleanHeading(m[2]), body: raw.slice(start, end).trim() };
    }).filter((s) => s.heading || s.body);
  }

  const labelledSource = hits.length === 1
    ? raw.slice((hits[0].index || 0) + hits[0][0].length).trim()
    : raw;
  const labelled = labelledSections(labelledSource);
  if (labelled.length >= 2) return labelled.slice(0, 6);

  if (hits.length === 1) {
    const start = (hits[0].index || 0) + hits[0][0].length;
    return [{ heading: cleanHeading(hits[0][2]), body: raw.slice(start).trim() }];
  }

  const chunks = raw
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (chunks.length >= 2) {
    return chunks.map((body, i) => ({
      heading: inferredHeading(body, i),
      body,
    }));
  }
  return [{ heading: 'Overview', body: raw || 'No response text available.' }];
}

function labelledSections(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];
  let current = null;
  const labelRe = /^\s*(?:(?:[-*]|\d+[.)])\s+)?(?:\*\*)?([^:*#\n]{3,70}?)(?:\*\*)?\s*(?::| - | — | – )\s*(.*)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(labelRe);
    const label = m ? cleanHeading(m[1]) : '';
    const rest = m ? (m[2] || '').trim() : '';
    const looksLikeLabel = Boolean(
      m &&
      label.length >= 3 &&
      label.length <= 64 &&
      !/[.!?]$/.test(label) &&
      !/^(http|https|note|source)$/i.test(label)
    );

    if (looksLikeLabel) {
      if (current) out.push(current);
      current = { heading: label, body: rest };
    } else if (current) {
      current.body = `${current.body}\n${trimmed}`.trim();
    }
  }
  if (current) out.push(current);
  return out.filter((s) => s.heading && s.body);
}

function firstCleanLine(text) {
  return cleanText(String(text || '').split('\n').find((l) => l.trim() && !/^[-*_]{3,}$/.test(l.trim())) || '').slice(0, 180);
}

function inferredHeading(body, i) {
  const first = cleanText(body.split('\n')[0] || '');
  return first.length > 4 && first.length <= 56 ? first : `Part ${i + 1}`;
}

function cleanHeading(text) {
  return cleanText(text || 'Section').replace(/^\d+[.)]\s*/, '').slice(0, 64);
}

function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionPoints(body, max) {
  const lines = String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*_]{3,}$/.test(l) && !/^\|?\s*:?-{3,}/.test(l));
  const bullets = lines
    .filter((l) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l))
    .map(cleanText);
  const source = bullets.length ? bullets : lines.flatMap((l) => cleanText(l).split(/(?<=[.!?])\s+/));
  const pts = source.map(cleanText).filter((x) => x.length > 0 && x.length < 220);
  return (pts.length ? pts : ['See the full response for details.']).slice(0, max);
}

function extractSources(body) {
  const urls = [...String(body || '').matchAll(/https?:\/\/[^\s)]+/g)].slice(0, 3);
  return urls.length
    ? urls.map((m, i) => ({ title: `Source ${i + 1}`, url: m[0] }))
    : [{ title: 'Main response', url: '#' }];
}

function comparisonNames(prompt, answer, sections) {
  const tableLine = String(answer || '').split('\n').find((l) => l.includes('|') && /\|.*\|/.test(l));
  if (tableLine) {
    const cells = tableLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => cleanText(x));
    const names = cells.filter((x) => x && !/feature|criteria|category|metric/i.test(x));
    if (names.length >= 2) return names.slice(0, 6);
  }
  const vs = String(prompt || '').match(/compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+)/i);
  if (vs) {
    const trimTarget = (x) =>
      cleanText(x)
        .replace(/\s+\b(?:for|in|as|with|using)\b.*$/i, '')
        .replace(/\s+\b(?:briefly|shortly|concisely)\b.*$/i, '')
        .trim();
    return [trimTarget(vs[1]), trimTarget(vs[2])].filter(Boolean).slice(0, 6);
  }
  return sections.map((s) => cleanHeading(s.heading)).slice(0, 6);
}

function extractCodeFences(text) {
  const out = [];
  const re = /```(\w+)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push({ language: m[1] || 'text', code: (m[2] || '').trim() });
  }
  return out;
}

function langExt(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.includes('typescript') || l === 'ts') return 'ts';
  if (l.includes('javascript') || l === 'js') return 'js';
  if (l.includes('python') || l === 'py') return 'py';
  if (l.includes('json')) return 'json';
  if (l.includes('html')) return 'html';
  if (l.includes('css')) return 'css';
  return 'txt';
}

function slugName(text) {
  return cleanHeading(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function sectionForIndex(sections, i) {
  return sections[i % Math.max(1, sections.length)];
}

function clampItems(items, min, max, fallback) {
  const clipped = (items || []).filter(Boolean).slice(0, max);
  if (clipped.length >= min) return clipped;
  if (clipped.length > 0) return clipped;
  return (fallback || []).slice(0, min);
}

// Polar helper
function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// ─── Renderers ───────────────────────────────────────────────
// A burst container holds a center label (or hero element for compare) and a
// responsive grid of cards below. Cards stagger in via a translate+fade.

function BurstStage({ accent, children, label, hero }) {
  return (
    <div className="mm-burst" style={{ '--accent': accent }}>
      <div className="mm-burst-rays" aria-hidden="true" />
      <div className="mm-burst-header">
        <span className="mm-burst-tag">{label}</span>
      </div>
      {hero && <div className="mm-burst-hero">{hero}</div>}
      <div className="mm-burst-cards">{children}</div>
    </div>
  );
}

// ── Research
function ResearchView({ data, accent }) {
  const sections = data.sections || [];
  return (
    <BurstStage accent={accent} label="research">
      {sections.map((sec, i) => {
        const sectionText = `## ${sec.heading}\n\n${(sec.points || []).map((pt) => `- ${pt}`).join('\n')}\n\nSources:\n${(sec.sources || []).map((s) => `- ${s.title} (${s.url})`).join('\n')}`;
        return (
          <div key={i} className="mm-card mm-card-research" style={{ '--i': i }}>
            <header>
              <span className="mm-card-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="mm-card-title">{sec.heading}</span>
              <CopyButton tiny getText={() => sectionText} />
            </header>
            <ul>
              {(sec.points || []).map((pt, j) => <li key={j}>{pt}</li>)}
            </ul>
            {sec.sources?.length > 0 && (
              <div className="mm-sources">
                <div className="mm-sources-label">sources</div>
                {sec.sources.map((s, j) => (
                  <a key={j} href={s.url} target="_blank" rel="noreferrer">
                    <span className="mm-src-dot" /> {s.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </BurstStage>
  );
}

// ── Code
function CodeView({ data, accent }) {
  const files = data.files || [];
  return (
    <BurstStage accent={accent} label="code">
      {files.map((f, i) => {
        const blob = `// ${f.name}\n${f.snippet || ''}`;
        return (
          <div key={i} className="mm-card mm-card-code" style={{ '--i': i }}>
            <header>
              <span className="mm-file-icon">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <path d="M2.5 1.5h5L9.5 3.5v7h-7v-9z" />
                  <path d="M7.5 1.5v2h2" />
                </svg>
              </span>
              <span className="mm-card-title mono">{f.name}</span>
              <span className="mm-lang">{f.language}</span>
              <CopyButton tiny getText={() => blob} />
            </header>
            <pre className="mm-snippet"><code>{f.snippet || ''}</code></pre>
            {f.notes?.length > 0 && (
              <ul className="mm-notes">
                {f.notes.map((nt, j) => <li key={j}>{nt}</li>)}
              </ul>
            )}
          </div>
        );
      })}
    </BurstStage>
  );
}

// ── Compare
function CompareView({ data, accent }) {
  const ranking = data.ranking || [];
  const targets = data.targets || [];

  const heroEl = (
    <div className="mm-rank-card">
      <div className="mm-rank-head">
        <span className="mono mm-rank-tag">final ranking</span>
        <CopyButton tiny getText={() => ranking.map((r) => `${r.rank}. ${r.name} — ${r.score}/10 — ${r.takeaway}`).join('\n')} />
      </div>
      {ranking.map((r) => (
        <div key={r.name} className={'mm-rank-row' + (r.rank === 1 ? ' top' : '')}>
          <span className="mm-rank-pos">#{r.rank}</span>
          <span className="mm-rank-name">{r.name}</span>
          <span className="mm-rank-score">{Number(r.score).toFixed(1)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <BurstStage accent={accent} label="compare" hero={heroEl}>
      {targets.map((t, i) => {
        const r = ranking.find((x) => x.name === t.name);
        const text = `${t.name}\n\nPros:\n${(t.pros || []).map((x) => `- ${x}`).join('\n')}\n\nCons:\n${(t.cons || []).map((x) => `- ${x}`).join('\n')}\n\nReason: ${t.reason || ''}`;
        return (
          <div key={t.name} className="mm-card mm-card-compare" style={{ '--i': i }}>
            <header>
              {r && <span className="mm-rank-badge">#{r.rank}</span>}
              <span className="mm-card-title">{t.name}</span>
              {r && <span className="mm-rank-score-inline">{Number(r.score).toFixed(1)}</span>}
              <CopyButton tiny getText={() => text} />
            </header>
            <div className="mm-pc-grid">
              <div className="mm-col">
                <div className="mm-col-h">pros</div>
                <ul>{(t.pros || []).map((x, j) => <li key={j}>{x}</li>)}</ul>
              </div>
              <div className="mm-col">
                <div className="mm-col-h">cons</div>
                <ul className="con">{(t.cons || []).map((x, j) => <li key={j}>{x}</li>)}</ul>
              </div>
            </div>
            {t.reason && <div className="mm-reason"><span>why:</span> {t.reason}</div>}
          </div>
        );
      })}
    </BurstStage>
  );
}

// ── Plan
function PlanView({ data, accent }) {
  const phases = data.phases || [];
  return (
    <BurstStage accent={accent} label="plan">
      {phases.map((ph, i) => {
        const text = `Phase ${i + 1}: ${ph.title}\n${(ph.steps || []).map((s, j) => `${j + 1}. ${s}`).join('\n')}`;
        return (
          <div key={i} className="mm-card mm-card-plan" style={{ '--i': i }}>
            <header>
              <span className="mm-phase-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="mm-card-title">{ph.title}</span>
              <CopyButton tiny getText={() => text} />
            </header>
            <ol>
              {(ph.steps || []).map((s, j) => <li key={j}>{s}</li>)}
            </ol>
          </div>
        );
      })}
    </BurstStage>
  );
}

// ─── Orbital node extraction ─────────────────────────────────
// Each template's data flattens to a list of "nodes" — one node per
// categorized chunk. Nodes are what orbit around A in the orbital mindmap.
// The shape: { key, label, kind, body: ReactNode, copyText: string }.
// Validate that the data shape matches what the template's renderer
// expects. Returns true if it's safe to feed to extractNodes; false
// if any required field is the wrong type. Used to gate Cerebras
// prefetch results before they reach React render.
function isValidMindmapData(template, data) {
  if (!data || typeof data !== 'object') return false;
  if (template === 'research') return Array.isArray(data.sections);
  if (template === 'code')     return Array.isArray(data.files);
  if (template === 'compare')  return Array.isArray(data.targets);
  if (template === 'plan')     return Array.isArray(data.phases);
  return false;
}

function extractNodes(template, data) {
  // Defensive: any unexpected shape from a model that fudged the JSON
  // schema would otherwise crash render and blank the page. Validate
  // before iterating; fall back to empty so the caller can derive
  // locally from the markdown answer instead.
  if (!data || !isValidMindmapData(template, data)) return [];

  // Each node has TWO bodies:
  //   summaryBody — concise: 1 short line + count badge. Used in the
  //                 orbital mindmap so cards fit without crowding the
  //                 composer.
  //   body        — full: pros/cons grid / snippet / sources. Used in
  //                 the focused-node overlay when the user clicks.

  if (template === 'research') {
    return (data.sections || []).map((s, i) => {
      const pts = s.points || [];
      const srcs = s.sources || [];
      return {
        key: `research-${i}`,
        kind: 'research',
        label: s.heading || `section ${i + 1}`,
        sub: srcs.length ? `${srcs.length} src` : null,
        summaryBody: (
          <div className="mm-orbit-summary">
            {pts[0] && <div className="mm-orbit-summary-line">{pts[0]}</div>}
            {pts.length > 1 && <div className="mm-orbit-summary-more">+ {pts.length - 1} more</div>}
          </div>
        ),
        body: (
          <div className="mm-orbit-body">
            <ul>{pts.map((p, j) => <li key={j}>{p}</li>)}</ul>
            {srcs.length > 0 && (
              <div className="mm-orbit-sources">
                <span className="mm-orbit-sources-label">sources</span>
                {srcs.map((src, j) => (
                  <a key={j} href={src.url} target="_blank" rel="noreferrer">
                    <span className="mm-src-dot" />{src.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        ),
        copyText: `## ${s.heading}\n${pts.map((p) => `- ${p}`).join('\n')}\nSources:\n${srcs.map((x) => `- ${x.title} (${x.url})`).join('\n')}`,
      };
    });
  }

  if (template === 'code') {
    return (data.files || []).map((f, i) => {
      const firstLine = (f.snippet || '').split('\n').find((l) => l.trim().length) || '';
      const notes = f.notes || [];
      return {
        key: `code-${i}`,
        kind: 'code',
        label: f.name || `file ${i + 1}`,
        sub: f.language,
        summaryBody: (
          <div className="mm-orbit-summary">
            {firstLine && <code className="mm-orbit-summary-code">{firstLine.length > 38 ? firstLine.slice(0, 38) + '…' : firstLine}</code>}
            {notes[0] && <div className="mm-orbit-summary-line">{notes[0]}</div>}
            {notes.length > 1 && <div className="mm-orbit-summary-more">+ {notes.length - 1} more</div>}
          </div>
        ),
        body: (
          <div className="mm-orbit-body">
            <pre className="mm-orbit-snippet"><code>{f.snippet || ''}</code></pre>
            {notes.length > 0 && (
              <ul className="mm-orbit-notes">{notes.map((n, j) => <li key={j}>{n}</li>)}</ul>
            )}
          </div>
        ),
        copyText: `// ${f.name}\n${f.snippet || ''}`,
      };
    });
  }

  if (template === 'compare') {
    const ranking = data.ranking || [];
    return (data.targets || []).map((t, i) => {
      const r = ranking.find((x) => x.name === t.name);
      const pros = t.pros || [];
      const cons = t.cons || [];
      const why = t.reason || '';
      return {
        key: `compare-${i}`,
        kind: 'compare',
        label: t.name || `target ${i + 1}`,
        sub: r ? `#${r.rank} · ${Number(r.score).toFixed(1)}` : null,
        summaryBody: (
          <div className="mm-orbit-summary">
            {why && <div className="mm-orbit-summary-line">{why.length > 80 ? why.slice(0, 80) + '…' : why}</div>}
            <div className="mm-orbit-summary-counts">
              <span className="pro">{pros.length} pros</span>
              <span className="con">{cons.length} cons</span>
            </div>
          </div>
        ),
        body: (
          <div className="mm-orbit-body">
            <div className="mm-pc-grid">
              <div className="mm-col">
                <div className="mm-col-h">pros</div>
                <ul>{pros.map((p, j) => <li key={j}>{p}</li>)}</ul>
              </div>
              <div className="mm-col">
                <div className="mm-col-h">cons</div>
                <ul className="con">{cons.map((p, j) => <li key={j}>{p}</li>)}</ul>
              </div>
            </div>
            {why && <div className="mm-reason"><span>why:</span> {why}</div>}
          </div>
        ),
        copyText: `${t.name}\nPros: ${pros.join(', ')}\nCons: ${cons.join(', ')}\n${why ? 'Why: ' + why : ''}`,
      };
    });
  }

  // plan + fallback
  return (data.phases || []).map((p, i) => {
    const steps = p.steps || [];
    return {
      key: `plan-${i}`,
      kind: 'plan',
      label: p.title || `phase ${i + 1}`,
      sub: `phase ${String(i + 1).padStart(2, '0')}`,
      summaryBody: (
        <div className="mm-orbit-summary">
          {steps[0] && <div className="mm-orbit-summary-line"><span className="mm-orbit-summary-num">1.</span> {steps[0]}</div>}
          {steps.length > 1 && <div className="mm-orbit-summary-more">+ {steps.length - 1} more</div>}
        </div>
      ),
      body: (
        <div className="mm-orbit-body">
          <ol>{steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
        </div>
      ),
      copyText: `Phase ${i + 1}: ${p.title}\n${steps.map((s, j) => `${j + 1}. ${s}`).join('\n')}`,
    };
  });
}

// ─── Renderer map ───────────────────────────────────────────
const RENDERERS = {
  research: ResearchView,
  code: CodeView,
  compare: CompareView,
  plan: PlanView,
};

// Comprehensive categorization prompt used by the Cerebras pre-fetch
// (action-repetitive role). Unlike the lightweight TEMPLATE_DEFS prompts
// — which cap items + truncate strings for the orbital mini-cards —
// THIS prompt explicitly tells the model to preserve every detail
// from the assistant's reply. The result populates the FOCUSED-node
// view (full content) and feeds the orbital summary cards via the
// existing `deriveMindmapData` fallback / cached `data` field.
function comprehensiveCategorizePrompt(template, prompt, answer) {
  const schemas = {
    research: `{"type":"research","summary":"<1-2 sentence overview>","sections":[
  {"heading":"<short heading>","points":["<full point — keep every word the assistant included for this heading>"],"sources":[{"title":"<short>","url":"<url or 'general knowledge'>"}]}
]}`,
    code: `{"type":"code","summary":"<1-2 sentence overview>","files":[
  {"name":"<filename>","language":"<lang>","snippet":"<full code block as written — escape newlines as \\n>","notes":["<each note exactly as written>"]}
]}`,
    compare: `{"type":"compare","summary":"<short overview>","ranking":[
  {"name":"<>","rank":<1-based>,"score":<0-10 number>,"takeaway":"<full takeaway sentence>"}
],"targets":[
  {"name":"<must match a name in ranking>","pros":["<every pro the assistant listed for this target>"],"cons":["<every con>"],"reason":"<full reason for the rank>"}
]}`,
    plan: `{"type":"plan","summary":"<short overview>","phases":[
  {"title":"<short>","steps":["<every step verbatim>"]}
]}`,
  };
  const schema = schemas[template] || schemas.plan;
  return `You are categorizing the assistant's reply below into a structured JSON shape so it can be visualized as a mindmap. PRESERVE ALL DETAIL — every bullet, every sentence, every code line the assistant wrote should appear in the JSON. Do not truncate. Do not paraphrase. Do not invent content the assistant did not include. Preserve any LaTeX math spans verbatim ($...$, $$...$$) — do not convert them to plain text.

Return ONLY valid JSON. No prose. No markdown fences.

Schema (use as many sections / files / targets / phases as the reply naturally has):

${schema}

User's original prompt:
${prompt}

Assistant's reply (the source of truth — categorize THIS, do not answer the prompt yourself):

<<<REPLY
${answer}
REPLY>>>`;
}

Object.assign(window, {
  TEMPLATE_DEFS,
  TEMPLATE_KEYS,
  FALLBACK_DATA,
  detectTemplate,
  CopyButton,
  RENDERERS,
  deriveMindmapData,
  comprehensiveCategorizePrompt,
  isValidMindmapData,
  ResearchView,
  CodeView,
  CompareView,
  PlanView,
  extractNodes,
});
