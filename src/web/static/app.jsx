// hero-mindmap.jsx — Lattice dynamic chat with burst-to-mindmap flow.
//
// Phases:
//   idle        → big composer centered, hero text above
//   loading     → prompt locks in, agents "think"
//   response    → composer (A) pinned at bottom; response cards (B…) stack
//                 above A, newest just above A (older ones pushed up); a hint
//                 sits at the very top of the stack — pull / click to expand.
//   collapsing  → responses + composer converge toward a central singularity
//                 (the "big bang" pre-bang); transient (~520ms).
//   mindmap     → cards burst out from the central singularity into the
//                 sorted template grid; each card gently floats once settled.
//   imploding   → reverse of mindmap → response (cards converge to center,
//                 then the stack re-materializes); transient (~440ms).

// Mapped to the system's real role roster (default-registry.ts).
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

function Sidebar({ phase, latestResponse }) {
  const [usage, setUsage] = React.useState({ roles: {}, mode: 'round-robin' });
  React.useEffect(() => {
    let cancelled = false;
    const fetchUsage = async () => {
      try {
        const r = await fetch('/api/usage.json');
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setUsage(j);
      } catch {/* ignore */}
    };
    fetchUsage();
    const id = setInterval(fetchUsage, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  React.useEffect(() => {
    if (phase !== 'response') return;
    fetch('/api/usage.json').then((r) => r.ok && r.json().then(setUsage)).catch(() => {});
  }, [phase]);

  const used = React.useMemo(() => {
    const map = Object.fromEntries(MM_AGENTS.map((a) => [a.id, 0]));
    const roles = usage.roles || {};
    for (const a of MM_AGENTS) {
      const r = roles[a.id];
      if (!r || r.registered === false) continue;
      map[a.id] = (r.successCount || 0) * 1000;
    }
    if (phase === 'loading') {
      for (const a of MM_AGENTS) map[a.id] += 800 + Math.random() * 800;
    }
    return map;
  }, [usage, phase]);

  const totalQuota = MM_AGENTS.reduce((s, a) => s + a.quota, 0);

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
              <div className="dim">routing[{latestResponse?.template || 'auto'}]</div>
            </>
          )}
          {phase === 'response' && (
            <>
              <div style={{ color: 'oklch(0.72 0.18 145)' }}>› synthesized</div>
              <div className="dim">template={latestResponse?.template}</div>
            </>
          )}
          {(phase === 'mindmap' || phase === 'collapsing' || phase === 'imploding') && (
            <>
              <div style={{ color: 'oklch(0.74 0.17 52)' }}>› burst expanded</div>
              <div className="dim">sections={
                (latestResponse?.data?.sections?.length
                  || latestResponse?.data?.files?.length
                  || latestResponse?.data?.targets?.length
                  || latestResponse?.data?.phases?.length) || 0
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
function Composer({ value, onChange, onSubmit, autoFocus, disabled }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const ta = ref.current; if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  }, [value]);
  return (
    <div className="mm-composer">
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

// ─── Response card (stacked above A) ───────────────────────
// Each B card carries its own prompt as a faint header line so the user can
// scan the thread at a glance. Newest gets `data-newest`, which the CSS uses
// to scale it up slightly and brighten the accent — a subtle "you're looking
// at the latest result" cue.
function StackedResponse({ entry, accent, isNewest, isOlder, stackIndex }) {
  const tpl = TEMPLATE_DEFS[entry.template];
  return (
    <div
      className={'mm-stacked-response' + (isNewest ? ' newest' : '') + (isOlder ? ' older' : '')}
      data-newest={isNewest ? 'true' : 'false'}
      style={{ '--accent': accent, '--stack-i': stackIndex }}
    >
      <div className="mm-stacked-meta">
        <span className="mm-stacked-prompt">› {entry.prompt}</span>
        <span className="mm-template-pill">
          <span className="mm-template-dot" />
          {tpl?.label || entry.template}
        </span>
      </div>
      <div className="mm-stacked-body">{entry.text}</div>
      <div className="mm-stacked-foot">
        <CopyButton getText={() => formatResponseText(entry)} />
      </div>
    </div>
  );
}

// ─── Hint bar (top of the stack — pull down / click to burst) ───
function HintBar({ onExpand, disabled }) {
  const [dragY, setDragY] = React.useState(0);
  const startY = React.useRef(0);
  const dragging = React.useRef(false);
  const fired = React.useRef(false);

  const onPointerDown = (e) => {
    if (disabled) return;
    dragging.current = true;
    fired.current = false;
    startY.current = e.clientY;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e) => {
    if (!dragging.current || fired.current) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDragY(Math.min(140, dy));
    if (dy > 70) {
      fired.current = true;
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
      className={'mm-hint-bar' + (disabled ? ' disabled' : '')}
      onClick={disabled ? undefined : onExpand}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ transform: `translateY(${dragY}px)` }}
      aria-label="Pull down to expand into mindmap"
    >
      <span className="mm-hint-rail" />
      <span className="mm-hint-glyph">
        <i /><i /><i />
      </span>
      <span className="mm-hint-text">
        {progress > 0.5 ? 'release // big bang' : 'pull or tap // expand the mindmap'}
      </span>
      <span className="mm-hint-arrow">
        <svg viewBox="0 0 16 10" fill="none">
          <path d="M2 2l6 6 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="mm-hint-progress">
        <span className="mm-hint-progress-fill" style={{ width: progress * 100 + '%' }} />
      </span>
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

// Stacked-response view.
// Layout (top → bottom):
//   [hint bar]
//   [older Bs … oldest at the top, newest just above A]
//   [composer A pinned at bottom]
// When phase === 'collapsing' the whole stack converges toward stage-center
// (the singularity); the hint pulls inward and the composer rises to the
// center too. When phase === 'response' (back from imploding) the stack
// re-materializes with an entrance animation per child.
function ResponseStackView({
  draft, setDraft, submit, responses, expand, reset, phase,
}) {
  const newest = responses[responses.length - 1];
  const accent = newest ? (TEMPLATE_DEFS[newest.template]?.accent || '#f5a25b') : '#f5a25b';
  // Render order top→bottom matches DOM order: hint, oldest…newest, composer.
  // Oldest goes first in DOM (top); newest goes last (just above composer).
  const ordered = responses; // already oldest→newest

  const collapsing = phase === 'collapsing';
  const imploding = phase === 'imploding';
  // `entering` plays the materialize animation right after returning from the
  // mindmap. We toggle it off after the animation duration so a subsequent
  // submit doesn't re-trigger it.
  const [entering, setEntering] = React.useState(imploding);
  React.useEffect(() => {
    if (imploding) {
      setEntering(true);
      const t = setTimeout(() => setEntering(false), 600);
      return () => clearTimeout(t);
    }
  }, [imploding]);

  return (
    <div
      className={
        'mm-phase mm-phase-response' +
        (collapsing ? ' collapsing' : '') +
        (entering ? ' entering' : '')
      }
      style={{ '--accent': accent }}
    >
      <div className="mm-stack-wrap" style={{ '--stack-size': ordered.length }}>
        <div className="mm-stack-hint-slot">
          <HintBar onExpand={expand} disabled={collapsing || imploding || ordered.length === 0} />
        </div>
        <div className="mm-stack-list">
          <div className="mm-stack-tools">
            <button className="mm-reset" onClick={reset} title="New thread — wipes the response stack">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
                <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
              </svg>
              <span>new thread</span>
            </button>
            <span className="mm-stack-count">{ordered.length} {ordered.length === 1 ? 'response' : 'responses'}</span>
          </div>
          {ordered.map((entry, i) => (
            <StackedResponse
              key={entry.id}
              entry={entry}
              accent={TEMPLATE_DEFS[entry.template]?.accent || accent}
              isNewest={i === ordered.length - 1}
              isOlder={i !== ordered.length - 1}
              stackIndex={ordered.length - 1 - i /* 0 = newest, 1 = next, … */}
            />
          ))}
        </div>
        <div className="mm-stack-composer-slot">
          <Composer value={draft} onChange={setDraft} onSubmit={submit} />
        </div>
      </div>
    </div>
  );
}

// Mindmap (post-burst) — newest response expanded into the sorted template
// grid. Cards animate from singularity (center) outward on mount, then
// gently float once settled. Pressing collapse fires an implode animation
// and we return to the response stack.
function MindmapView({ responses, collapse, reset, phase }) {
  const newest = responses[responses.length - 1];
  if (!newest) return null;
  const accent = TEMPLATE_DEFS[newest.template]?.accent || '#f5a25b';
  const R = RENDERERS[newest.template] || PlanView;

  // Phase === 'imploding' means user just hit collapse — wait for the burst
  // implode animation to finish before switching to response.
  const imploding = phase === 'imploding';

  return (
    <div className={'mm-phase mm-phase-mindmap' + (imploding ? ' imploding' : '')}
      style={{ '--accent': accent }}>
      <div className="mm-thread-strip">
        <button className="mm-collapse" onClick={collapse} title="Collapse back to thread">
          <svg viewBox="0 0 16 10" fill="none">
            <path d="M2 8l6-6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>collapse</span>
        </button>
        <div className="mm-thread-content">
          <span className="mm-thread-prompt">{newest.prompt}</span>
          <span className="mm-thread-arrow">→</span>
          <span className="mm-thread-template" style={{ '--c': accent }}>
            <i />{TEMPLATE_DEFS[newest.template]?.label || newest.template}
          </span>
        </div>
        <div className="mm-thread-actions">
          <span className="mm-thread-counter">{responses.length} in thread</span>
          <CopyButton getText={() => formatResponseText(newest)} />
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
        <R data={newest.data} accent={accent} />
      </div>
    </div>
  );
}

// ─── shared helper (used by stacked response + thread strip) ─
function formatResponseText(entry) {
  if (!entry) return '';
  const { template, data, text } = entry;
  let out = (text || '') + '\n\n';
  if (template === 'research') {
    for (const sec of (data && data.sections) || []) {
      out += `## ${sec.heading}\n${(sec.points || []).map((p) => `- ${p}`).join('\n')}\n`;
      if (sec.sources?.length) out += `Sources:\n${sec.sources.map((s) => `- ${s.title} (${s.url})`).join('\n')}\n`;
      out += '\n';
    }
  } else if (template === 'code') {
    for (const f of (data && data.files) || []) {
      out += `### ${f.name} (${f.language})\n\`\`\`\n${f.snippet}\n\`\`\`\n${(f.notes || []).map((n) => `- ${n}`).join('\n')}\n\n`;
    }
  } else if (template === 'compare') {
    out += 'Ranking:\n';
    for (const r of (data && data.ranking) || []) out += `${r.rank}. ${r.name} — ${r.score}/10 — ${r.takeaway}\n`;
    out += '\n';
    for (const t of (data && data.targets) || []) {
      out += `### ${t.name}\nPros: ${(t.pros || []).join(', ')}\nCons: ${(t.cons || []).join(', ')}\nReason: ${t.reason}\n\n`;
    }
  } else if (template === 'plan') {
    for (const ph of (data && data.phases) || []) {
      out += `### ${ph.title}\n${(ph.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
    }
  }
  return out.trim();
}

// ─── App ───────────────────────────────────────────────────
const STACK_LS_KEY = 'lattice.responseStack.v2';
const COLLAPSE_DURATION_MS = 520;
const IMPLODE_DURATION_MS = 440;

function loadPersistedStack() {
  try {
    const raw = localStorage.getItem(STACK_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) =>
      e && typeof e.id === 'string' && typeof e.prompt === 'string' &&
      e.response && TEMPLATE_DEFS[e.response.template]
    ).map((e) => ({ id: e.id, prompt: e.prompt, ...e.response }));
  } catch { return []; }
}
function savePersistedStack(responses) {
  try {
    const slim = responses.map((r) => ({
      id: r.id, prompt: r.prompt,
      response: { template: r.template, text: r.text, data: r.data },
    }));
    localStorage.setItem(STACK_LS_KEY, JSON.stringify(slim));
  } catch {}
}
function clearPersistedStack() {
  try { localStorage.removeItem(STACK_LS_KEY); } catch {}
}

function HeroMindmap() {
  const initialStack = React.useMemo(loadPersistedStack, []);
  const [phase, setPhase] = React.useState(initialStack.length > 0 ? 'response' : 'idle');
  const [draft, setDraft] = React.useState('');
  const [currentPrompt, setCurrentPrompt] = React.useState('');
  const [responses, setResponses] = React.useState(initialStack);

  const newest = responses[responses.length - 1] || null;
  const accent = newest ? (TEMPLATE_DEFS[newest.template]?.accent || '#f5a25b') : '#f5a25b';

  const submit = async () => {
    const q = draft.trim();
    if (!q) return;
    const template = detectTemplate(q);
    setCurrentPrompt(q);
    setDraft('');
    setPhase('loading');

    try {
      const sys = TEMPLATE_DEFS[template].prompt(q);
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
        new Promise((r) => setTimeout(r, 1600)),
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
      const entry = {
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        prompt: q,
        template, text, data: parsed,
      };
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    } catch (e) {
      const entry = {
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        prompt: q,
        template, text: 'Synthesized response.', data: FALLBACK_DATA[template],
      };
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    }
  };

  // Big-bang expand. We flip to 'collapsing' first; the response view's
  // .collapsing styles animate the stack toward center. After the animation
  // settles we switch to 'mindmap' so the burst stage mounts and its cards
  // animate outward from center.
  const expand = () => {
    if (phase !== 'response') return;
    setPhase('collapsing');
    setTimeout(() => setPhase('mindmap'), COLLAPSE_DURATION_MS);
  };
  // Reverse: implode the burst, then re-materialize the stack.
  const collapse = () => {
    if (phase !== 'mindmap') return;
    setPhase('imploding');
    setTimeout(() => setPhase('response'), IMPLODE_DURATION_MS);
  };
  const reset = () => {
    setPhase('idle');
    setCurrentPrompt('');
    setDraft('');
    setResponses([]);
    clearPersistedStack();
  };

  return (
    <div className="mm-root" data-phase={phase}>
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

      <Sidebar phase={phase} latestResponse={newest} />

      <div className="mm-stage" data-phase={phase} style={{ '--accent': accent }}>
        {phase === 'idle' && (
          <IdleView draft={draft} setDraft={setDraft} submit={submit} />
        )}
        {phase === 'loading' && (
          <LoadingView prompt={currentPrompt} />
        )}
        {(phase === 'response' || phase === 'collapsing' || phase === 'imploding') && (
          <ResponseStackView
            draft={draft} setDraft={setDraft} submit={submit}
            responses={responses} expand={expand} reset={reset} phase={phase}
          />
        )}
        {phase === 'mindmap' && (
          <MindmapView responses={responses} collapse={collapse} reset={reset} phase={phase} />
        )}
      </div>
    </div>
  );
}

window.HeroMindmap = HeroMindmap;
