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
    accent: '#7aa2ff',
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
    accent: '#6bd6a8',
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
    accent: '#c08bff',
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
    accent: '#f5a25b',
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

// ─── Renderer map ───────────────────────────────────────────
const RENDERERS = {
  research: ResearchView,
  code: CodeView,
  compare: CompareView,
  plan: PlanView,
};

Object.assign(window, {
  TEMPLATE_DEFS,
  TEMPLATE_KEYS,
  FALLBACK_DATA,
  detectTemplate,
  CopyButton,
  RENDERERS,
  ResearchView,
  CodeView,
  CompareView,
  PlanView,
});
