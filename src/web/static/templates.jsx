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
function extractNodes(template, data) {
  if (!data) return [];

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
  extractNodes,
});
