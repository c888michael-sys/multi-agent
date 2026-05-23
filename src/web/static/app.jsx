// hero-mindmap.jsx — Lattice dynamic chat with burst-to-mindmap flow.
//
// Phases:
//   idle     → big composer centered, hero text above
//   loading  → prompt locks in, agents "think"
//   response → response card on top, prompt card below, copy + pull handle
//   mindmap  → prompt+response collapse, template-specific burst view fills stage

// Mapped to the system's real role roster (default-registry.ts).
// Internally there are 6 roles; we surface the 5 the orchestrator actively
// engages from the UI's perspective. Colors are picked to keep the prototype's
// rainbow distribution.
const MM_AGENTS = [
  { id: 'orchestration',     name: 'Orchestrator', color: '#f5a25b', quota: 128000 },
  { id: 'perception',        name: 'Perception',   color: '#7aa2ff', quota: 128000 },
  { id: 'reasoning',         name: 'Reasoning',    color: '#c08bff', quota: 128000 },
  { id: 'action-code',       name: 'Coder',        color: '#6bd6a8', quota: 128000 },
  { id: 'action-structural', name: 'Structural',   color: '#ff8aa0', quota: 128000 },
];

// ─── Cursor-attracted particle constellation overlay ─────────
function ConstellationOverlay() {
  const canvasRef = React.useRef(null);
  const mouseRef = React.useRef({ x: -9999, y: -9999, active: false });
  const rafRef = React.useRef(0);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const W = () => canvas.getBoundingClientRect().width;
    const H = () => canvas.getBoundingClientRect().height;

    const parts = Array.from({ length: 64 }, () => ({
      x: Math.random() * W(),
      y: Math.random() * H(),
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      r: Math.random() * 1.1 + 0.6,
      phase: Math.random() * Math.PI * 2,
    }));

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
      mouseRef.current.active = true;
    };
    const onLeave = () => { mouseRef.current.active = false; };

    let t = 0;
    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      t += 1;
      const w = W(), h = H();
      ctx.clearRect(0, 0, w, h);
      const mx = mouseRef.current.x, my = mouseRef.current.y;
      const ma = mouseRef.current.active;

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        if (p.y > h + 20) p.y = -20;
        if (ma) {
          const dx = mx - p.x, dy = my - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 240 * 240) {
            const f = (1 - d2 / (240 * 240)) * 0.05;
            const d = Math.sqrt(d2 + 0.001);
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
        p.vx *= 0.985; p.vy *= 0.985;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 0.6) { p.vx *= 0.6 / sp; p.vy *= 0.6 / sp; }

        const pulse = 0.55 + 0.45 * Math.sin(t * 0.03 + p.phase);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245,243,239,${0.55 * pulse})`;
        ctx.fill();
      }

      const link = 130;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i], b = parts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < link * link) {
            const d = Math.sqrt(d2);
            const op = (1 - d / link) * 0.18;
            let boost = 0;
            if (ma) {
              const mxm = (a.x + b.x) / 2 - mx;
              const mym = (a.y + b.y) / 2 - my;
              const md = Math.hypot(mxm, mym);
              if (md < 220) boost = (1 - md / 220) * 0.5;
            }
            ctx.strokeStyle = `rgba(245,162,91,${op + boost * 0.35})`;
            ctx.lineWidth = 0.5 + boost * 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      if (ma) {
        const r1 = 80 + Math.sin(t * 0.04) * 6;
        const grad = ctx.createRadialGradient(mx, my, 0, mx, my, r1);
        grad.addColorStop(0, 'rgba(245,162,91,0.18)');
        grad.addColorStop(0.5, 'rgba(245,162,91,0.05)');
        grad.addColorStop(1, 'rgba(245,162,91,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, r1, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    render();

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="mm-canvas" />;
}

// ─── Sidebar ────────────────────────────────────────────────
function CompactNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function Sidebar({ phase, response, prompt }) {
  // Compute live agent usage based on current phase.
  const used = React.useMemo(() => {
    const map = Object.fromEntries(MM_AGENTS.map((a) => [a.id, 0]));
    if (phase === 'idle') return map;
    if (phase === 'loading') {
      // partial usage during thinking
      for (const a of MM_AGENTS) map[a.id] = 4000 + Math.random() * 6000;
    } else if (response) {
      // attribute usage based on template
      const tpl = response.template;
      const weights = {
        research: { 'perception': 0.45, 'orchestration': 0.15, 'action-structural': 0.2, 'reasoning': 0.1, 'action-code': 0.1 },
        code:     { 'action-code': 0.5, 'orchestration': 0.15, 'reasoning': 0.15, 'action-structural': 0.1, 'perception': 0.1 },
        compare:  { 'perception': 0.3, 'reasoning': 0.35, 'orchestration': 0.15, 'action-structural': 0.1, 'action-code': 0.1 },
        plan:     { 'orchestration': 0.45, 'perception': 0.15, 'reasoning': 0.15, 'action-structural': 0.15, 'action-code': 0.1 },
      }[tpl] || { 'orchestration': 0.25, 'perception': 0.25, 'action-code': 0.15, 'reasoning': 0.15, 'action-structural': 0.2 };
      const totalUsed = 32000 + (prompt?.length || 0) * 28;
      for (const a of MM_AGENTS) map[a.id] = Math.round(totalUsed * (weights[a.id] || 0.1));
    }
    return map;
  }, [phase, response, prompt]);

  const total = Object.values(used).reduce((s, v) => s + v, 0);
  const totalQuota = MM_AGENTS.reduce((s, a) => s + a.quota, 0);
  const pct = (total / totalQuota) * 100;

  // animate
  const [disp, setDisp] = React.useState(used);
  React.useEffect(() => {
    const start = { ...disp };
    const t0 = performance.now();
    let raf;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 700);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = {};
      for (const k of Object.keys(used)) {
        next[k] = Math.round(start[k] + (used[k] - start[k]) * eased);
      }
      setDisp(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used]);

  const dispTotal = Object.values(disp).reduce((s, v) => s + v, 0);
  const dispPct = (dispTotal / totalQuota) * 100;

  return (
    <aside className="mm-sidebar">
      <div className="mm-section">
        <div className="mm-lbl">agents <i>{phase === 'loading' ? '5 thinking' : '5 ready'}</i></div>
        {MM_AGENTS.map((a) => {
          const isActive = phase === 'loading';
          return (
            <div
              key={a.id}
              className={'mm-agent-row' + (isActive ? ' active' : '')}
              style={{ '--c': a.color }}
            >
              <span className="dot" />
              <span className="name">{a.name.toLowerCase()}<span className="ext">.agent</span></span>
              <span className="stat">{isActive ? 'thinking…' : '✓ ready'}</span>
            </div>
          );
        })}
      </div>

      <div className="mm-section">
        <div className="mm-lbl">context <i>{dispPct.toFixed(0)}% used</i></div>
        <div className="mm-gauge">
          <div className="mm-gauge-head">
            <div>
              <span className="mm-gauge-num">{CompactNumber(dispTotal)}</span>
              <span className="mm-gauge-of">/ {CompactNumber(totalQuota)} tokens</span>
            </div>
            <span className="mm-gauge-pct">{dispPct.toFixed(1)}%</span>
          </div>
          <div className="mm-gauge-bar">
            <div className="mm-gauge-fill" style={{ width: dispPct + '%' }} />
          </div>
        </div>
        {MM_AGENTS.map((a) => {
          const u = disp[a.id] || 0;
          const p = (u / a.quota) * 100;
          return (
            <div key={a.id} className="mm-bar-row" style={{ '--c': a.color }}>
              <span className="label">{a.name.toLowerCase()}</span>
              <span className="bar"><span className="fill" style={{ width: p + '%' }} /></span>
              <span className="num">{CompactNumber(u)}</span>
            </div>
          );
        })}
      </div>

      <div className="mm-section">
        <div className="mm-lbl">stream</div>
        <div className="mm-log">
          <div>13:42:08 orchestrator.boot</div>
          <div>13:42:09 routing.online</div>
          <div>13:42:11 all agents ready</div>
          {phase === 'loading' && (
            <>
              <div style={{ color: 'oklch(0.78 0.16 52)' }}>› dispatching to agents…</div>
              <div className="dim">routing[{response?.template || 'auto'}]</div>
            </>
          )}
          {phase === 'response' && (
            <>
              <div style={{ color: 'oklch(0.72 0.18 145)' }}>› synthesized</div>
              <div className="dim">template={response?.template}</div>
            </>
          )}
          {phase === 'mindmap' && (
            <>
              <div style={{ color: 'oklch(0.74 0.17 52)' }}>› burst expanded</div>
              <div className="dim">sections={
                (response?.data?.sections?.length
                  || response?.data?.files?.length
                  || response?.data?.targets?.length
                  || response?.data?.phases?.length) || 0
              }</div>
            </>
          )}
          {phase === 'idle' && (
            <div style={{ color: 'oklch(0.78 0.16 52)' }}>› awaiting prompt</div>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Composer (used in idle + response phases) ─────────────
function Composer({ value, onChange, onSubmit, autoFocus, accent, compact, disabled }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const ta = ref.current; if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  }, [value]);
  return (
    <div className={'mm-composer ' + (compact ? 'compact' : '')}>
      <div className="mm-composer-in">
        <div className="mm-composer-prefix">
          <span>$ lattice ~/ orchestrate</span>
          <span className="live">{disabled ? 'routing' : 'live'}</span>
        </div>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
          placeholder="› describe what you need — research, code, comparison, plan…"
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <div className="mm-composer-bar">
          <span className="mm-model"><i />orchestrator · 5 agents</span>
          <button className="mm-send" onClick={onSubmit} disabled={disabled || !value.trim()}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Prompt card (read-only, shown after submit) ───────────
function PromptCard({ text, accent, compact, onReset }) {
  return (
    <div className={'mm-prompt-card ' + (compact ? 'compact' : '')}>
      <div className="mm-prompt-head">
        <span className="mm-prompt-tag">your prompt</span>
        <button className="mm-reset" onClick={onReset} title="New thread">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
            <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
          </svg>
          <span>new</span>
        </button>
      </div>
      <div className="mm-prompt-body">{text}</div>
    </div>
  );
}

// ─── Response card ─────────────────────────────────────────
function ResponseCard({ response, accent, compact }) {
  if (!response) return null;
  const tpl = TEMPLATE_DEFS[response.template];
  return (
    <div className={'mm-response-card ' + (compact ? 'compact' : '')}
      style={{ '--accent': accent }}>
      <div className="mm-response-head">
        <span className="mm-template-pill">
          <span className="mm-template-dot" />
          {tpl?.label || response.template}
        </span>
        <CopyButton getText={() => formatResponseText(response)} />
      </div>
      <div className="mm-response-body">{response.text}</div>
      {!compact && response.preview && (
        <div className="mm-response-preview">
          {response.preview.map((p, i) => (
            <span key={i} className="mm-chip">
              <i style={{ background: accent }} />
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatResponseText(response) {
  if (!response) return '';
  const { template, data, text } = response;
  let out = text + '\n\n';
  if (template === 'research') {
    for (const sec of data.sections || []) {
      out += `## ${sec.heading}\n${(sec.points || []).map((p) => `- ${p}`).join('\n')}\n`;
      if (sec.sources?.length) out += `Sources:\n${sec.sources.map((s) => `- ${s.title} (${s.url})`).join('\n')}\n`;
      out += '\n';
    }
  } else if (template === 'code') {
    for (const f of data.files || []) {
      out += `### ${f.name} (${f.language})\n\`\`\`\n${f.snippet}\n\`\`\`\n${(f.notes || []).map((n) => `- ${n}`).join('\n')}\n\n`;
    }
  } else if (template === 'compare') {
    out += 'Ranking:\n';
    for (const r of data.ranking || []) out += `${r.rank}. ${r.name} — ${r.score}/10 — ${r.takeaway}\n`;
    out += '\n';
    for (const t of data.targets || []) {
      out += `### ${t.name}\nPros: ${(t.pros || []).join(', ')}\nCons: ${(t.cons || []).join(', ')}\nReason: ${t.reason}\n\n`;
    }
  } else if (template === 'plan') {
    for (const ph of data.phases || []) {
      out += `### ${ph.title}\n${(ph.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
    }
  }
  return out.trim();
}

// ─── Pull handle ───────────────────────────────────────────
function PullHandle({ onExpand, label }) {
  const [dragY, setDragY] = React.useState(0);
  const startY = React.useRef(0);
  const dragging = React.useRef(false);

  const onPointerDown = (e) => {
    dragging.current = true;
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging.current) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDragY(Math.min(140, dy));
    if (dy > 70) {
      dragging.current = false;
      setDragY(0);
      onExpand();
    }
  };
  const onPointerUp = () => {
    dragging.current = false;
    setDragY(0);
  };

  const progress = Math.min(1, dragY / 70);

  return (
    <button
      className="mm-pull"
      onClick={onExpand}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ transform: `translateY(${dragY}px)` }}
    >
      <span className="mm-pull-grip">
        <i /><i /><i />
      </span>
      <span className="mm-pull-arrow">
        <svg viewBox="0 0 16 10" fill="none">
          <path d="M2 2l6 6 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="mm-pull-label">
        {progress > 0.5 ? 'release to expand' : (label || 'pull down to expand into mindmap')}
      </span>
      <div className="mm-pull-progress">
        <div className="mm-pull-progress-fill" style={{ width: progress * 100 + '%' }} />
      </div>
    </button>
  );
}

// ─── Phase views ───────────────────────────────────────────

function IdleView({ draft, setDraft, submit }) {
  return (
    <div className="mm-phase mm-phase-idle">
      <div className="mm-hero">
        <div className="mm-eyebrow">
          <span className="mm-prefix">$</span> lattice/orchestrator
          <span className="dim">— v0.4.1</span>
          <span className="sep" />
          <span className="ok-dot" />
          <span className="dim">5/5 ready</span>
          <span className="caret" />
        </div>
        <h1 className="mm-h1">
          Many <em>minds,</em> one conversation.
        </h1>
        <p className="mm-sub">
          Describe what you need — research, code, comparison, plan — and the orchestrator
          routes it across five specialized agents.
        </p>
      </div>
      <div className="mm-composer-wrap">
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus />
      </div>
      <div className="mm-template-row">
        {TEMPLATE_KEYS.map((k) => (
          <span key={k} className="mm-template-hint" style={{ '--c': TEMPLATE_DEFS[k].accent }}>
            <i /> {TEMPLATE_DEFS[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function LoadingView({ prompt }) {
  // animated dispatch — agent chips light up sequentially
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % (MM_AGENTS.length + 1)), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="mm-phase mm-phase-loading">
      <div className="mm-prompt-card">
        <div className="mm-prompt-head">
          <span className="mm-prompt-tag">your prompt</span>
          <span className="mm-routing-pill">routing…</span>
        </div>
        <div className="mm-prompt-body">{prompt}</div>
      </div>
      <div className="mm-dispatch">
        {MM_AGENTS.map((a, i) => (
          <div key={a.id} className={'mm-dispatch-row ' + (i < step ? 'on' : '')}
            style={{ '--c': a.color }}>
            <span className="orb" />
            <span className="nm">{a.name}</span>
            <span className="st">{i < step ? 'engaged' : 'queued'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResponseView({ prompt, response, accent, expand, reset }) {
  return (
    <div className="mm-phase mm-phase-response">
      <ResponseCard response={response} accent={accent} />
      <PullHandle onExpand={expand} />
      <div className="mm-spacer" />
      <PromptCard text={prompt} onReset={reset} accent={accent} />
    </div>
  );
}

function MindmapView({ prompt, response, accent, collapse, reset }) {
  const R = RENDERERS[response.template] || PlanView;
  return (
    <div className="mm-phase mm-phase-mindmap">
      <div className="mm-thread-strip">
        <button className="mm-collapse" onClick={collapse} title="Collapse">
          <svg viewBox="0 0 16 10" fill="none">
            <path d="M2 8l6-6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>collapse</span>
        </button>
        <div className="mm-thread-content">
          <span className="mm-thread-prompt">{prompt}</span>
          <span className="mm-thread-arrow">→</span>
          <span className="mm-thread-template" style={{ '--c': accent }}>
            <i />{TEMPLATE_DEFS[response.template]?.label || response.template}
          </span>
        </div>
        <div className="mm-thread-actions">
          <CopyButton getText={() => formatResponseText(response)} />
          <button className="mm-thread-reset" onClick={reset} title="New thread">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
              <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
            </svg>
            <span>new</span>
          </button>
        </div>
      </div>
      <div className="mm-burst-wrap">
        <R data={response.data} accent={accent} />
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────
function HeroMindmap() {
  const [phase, setPhase] = React.useState('idle');
  const [draft, setDraft] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [response, setResponse] = React.useState(null); // {template, text, data}

  const accent = response ? TEMPLATE_DEFS[response.template]?.accent : '#f5a25b';

  const submit = async () => {
    const q = draft.trim();
    if (!q) return;
    const template = detectTemplate(q);
    setPrompt(q);
    setDraft('');
    setResponse({ template, text: '', data: null });
    setPhase('loading');

    try {
      const sys = TEMPLATE_DEFS[template].prompt(q);
      // Talk to our own backend instead of the design-studio's window.claude.complete.
      // The server side routes through the same Router + provider pool the CLI uses.
      const completeApi = async (prompt) => {
        const res = await fetch('/api/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) throw new Error(`/api/complete ${res.status}`);
        const json = await res.json();
        if (typeof json.reply !== 'string') throw new Error('bad response shape');
        return json.reply;
      };
      const [reply] = await Promise.all([
        completeApi(sys),
        new Promise((r) => setTimeout(r, 1600)),  // minimum dwell for animation
      ]);
      let parsed;
      try {
        const cleaned = reply.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        parsed = FALLBACK_DATA[template];
      }
      const text = typeof parsed.summary === 'string'
        ? parsed.summary
        : 'Synthesized response. Pull down to expand into a detailed mindmap.';
      setResponse({ template, text, data: parsed });
      setPhase('response');
    } catch (e) {
      setResponse({ template, text: 'Synthesized response.', data: FALLBACK_DATA[template] });
      setPhase('response');
    }
  };

  const expand = () => setPhase('mindmap');
  const collapse = () => setPhase('response');
  const reset = () => {
    setPhase('idle');
    setPrompt('');
    setDraft('');
    setResponse(null);
  };

  return (
    <div className="mm-root">
      <div className="mm-aurora" />
      <ConstellationOverlay />
      <div className="mm-vignette" />
      <div className="mm-scan" />

      <nav className="mm-nav">
        <div className="mm-brand">
          <svg viewBox="0 0 24 24" fill="none">
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
              <circle cx="4" cy="6" r="1.4" />
              <circle cx="20" cy="6" r="1.4" />
              <circle cx="4" cy="18" r="1.4" />
              <circle cx="20" cy="18" r="1.4" />
              <path d="M5 7l6 4M19 7l-6 4M5 17l6-4M19 17l-6-4" opacity="0.6" />
            </g>
          </svg>
          Lattice
        </div>
        <div className="mm-status"><i />5/5 AGENTS ONLINE</div>
      </nav>

      <Sidebar phase={phase} response={response} prompt={prompt} />

      <div className="mm-stage" data-phase={phase}>
        {phase === 'idle' && (
          <IdleView draft={draft} setDraft={setDraft} submit={submit} />
        )}
        {phase === 'loading' && (
          <LoadingView prompt={prompt} />
        )}
        {phase === 'response' && (
          <ResponseView prompt={prompt} response={response} accent={accent}
            expand={expand} reset={reset} />
        )}
        {phase === 'mindmap' && (
          <MindmapView prompt={prompt} response={response} accent={accent}
            collapse={collapse} reset={reset} />
        )}
      </div>
    </div>
  );
}

window.HeroMindmap = HeroMindmap;
