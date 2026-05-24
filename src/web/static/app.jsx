// app.jsx — Lattice multi-agent UI.
//
// Phases:
//   idle        → big composer centered, hero text above
//   loading     → prompt locks in, agents "think"
//   response    → composer A pinned at bottom; B's stack above; bar handle
//                 at top of canvas. Newest B sits at the vertical center.
//   collapsing  → orchestrated catalyst sequence (~1900 ms total):
//                 stage 1: bar slides DOWN to collision point (~420 ms)
//                 stage 2: tokens A (right) + B (left) fly horizontally
//                          inward and collide at center (~500 ms)
//                 stage 3: A locks; B shatters into N particle dots (250 ms)
//                 stage 4: particles arc downward in a gravity-driven
//                          fountain, scaling up with white vector trails;
//                          settle as the full-size category nodes (~880 ms)
//   mindmap     → A as active composer at center; category nodes positioned
//                 in the BOTTOM HALF (fan layout) connected back to A by
//                 dashed accent lines; nodes drift gently.
//   imploding   → reverse implode (~440 ms) then back to response.

// Agent roster colors — single cool palette so the constellation reads as
// "instrument panel" not "rainbow LEDs". Differentiation comes from hue
// shifts within a narrow blue-cyan band.
const MM_AGENTS = [
  { id: 'orchestration',     name: 'Orchestrator', color: 'oklch(0.82 0.14 230)', quota: 128000 },
  { id: 'perception',        name: 'Perception',   color: 'oklch(0.85 0.10 215)', quota: 128000 },
  { id: 'reasoning',         name: 'Reasoning',    color: 'oklch(0.80 0.08 260)', quota: 128000 },
  { id: 'action-code',       name: 'Coder',        color: 'oklch(0.86 0.08 195)', quota: 128000 },
  { id: 'action-structural', name: 'Structural',   color: 'oklch(0.78 0.06 240)', quota: 128000 },
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

    // Fewer, quieter particles — quantum lab, not nightclub.
    const parts = Array.from({ length: 40 }, () => ({
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

        const pulse = 0.5 + 0.5 * Math.sin(t * 0.025 + p.phase);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(244,244,244,${0.32 * pulse})`;
        ctx.fill();
      }

      const link = 140;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i], b = parts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < link * link) {
            const d = Math.sqrt(d2);
            const op = (1 - d / link) * 0.10;
            let boost = 0;
            if (ma) {
              const mxm = (a.x + b.x) / 2 - mx;
              const mym = (a.y + b.y) / 2 - my;
              const md = Math.hypot(mxm, mym);
              if (md < 240) boost = (1 - md / 240) * 0.45;
            }
            // Cool ice-blue lines, refined opacity.
            ctx.strokeStyle = `rgba(125,180,255,${op + boost * 0.28})`;
            ctx.lineWidth = 0.5 + boost * 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      if (ma) {
        const r1 = 90 + Math.sin(t * 0.04) * 6;
        const grad = ctx.createRadialGradient(mx, my, 0, mx, my, r1);
        grad.addColorStop(0, 'rgba(125,180,255,0.14)');
        grad.addColorStop(0.5, 'rgba(125,180,255,0.04)');
        grad.addColorStop(1, 'rgba(125,180,255,0)');
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
              <div style={{ color: 'var(--accent)' }}>› dispatching to agents…</div>
              <div className="dim">orchestrator.plan</div>
            </>
          )}
          {phase === 'response' && (
            <>
              <div style={{ color: 'oklch(0.85 0.10 195)' }}>› synthesized</div>
              <div className="dim">plan={latestResponse?.plan || '—'}</div>
            </>
          )}
          {(phase === 'mindmap' || phase === 'collapsing' || phase === 'imploding') && (
            <>
              <div style={{ color: 'var(--accent)' }}>› mindmap.open</div>
              <div className="dim">categories={
                latestResponse
                  ? (typeof extractCategoriesFromMarkdown === 'function'
                      ? extractCategoriesFromMarkdown(latestResponse.markdown || '').length
                      : 0)
                  : 0
              }</div>
            </>
          )}
          {phase === 'idle' && (
            <div style={{ color: 'var(--accent)' }}>› awaiting prompt</div>
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

// ─── Tiny markdown renderer ──────────────────────────────────
// No build step + no external library, so we ship a minimal markdown
// parser that handles the patterns the orchestrator actually produces:
// `# / ## / ###` headings, paragraphs, `- / * / 1.` lists, > blockquotes,
// fenced code blocks ```lang ... ```, inline `code`, **bold**, *italic*,
// and [link](url). Anything more exotic falls through as plain text.
//
// Two entry points:
//   <Markdown text={md} />       — full rendering
//   parseMarkdownBlocks(md)      — structured blocks for the orbital
//                                   mindmap's category extraction
function parseMarkdownBlocks(md) {
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) {
      blocks.push({ type: 'para', text: paraBuf.join(' ') });
      paraBuf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (/^```/.test(line)) {
      flushPara();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      i++; // skip closing fence
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // Blockquote — collect consecutive `> ` lines
    if (/^>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, '')); i++;
      }
      blocks.push({ type: 'quote', text: buf.join(' ') });
      continue;
    }
    // List — collect consecutive list items (any of -, *, +, N.)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const items = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        items.push(t);
        i++;
        // Continuation lines indented under the item — append.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    // Blank line — paragraph break
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    // Paragraph line — accumulate
    paraBuf.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

function renderInline(text, keyPrefix = '') {
  // Tokenize for `code`, **bold** / __bold__, *italic* / _italic_,
  // [link](url) — in that order so code spans aren't reparsed for emphasis.
  // The double-marker forms (** and __) come before the single-marker
  // forms (* and _) so they match greedily.
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(<code key={`${keyPrefix}c${k++}`}>{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={`${keyPrefix}b${k++}`}>{m[2].slice(2, -2)}</strong>);
    } else if (m[3]) {
      out.push(<em key={`${keyPrefix}i${k++}`}>{m[3].slice(1, -1)}</em>);
    } else if (m[4]) {
      const lm = m[4].match(/\[([^\]]+)\]\(([^)]+)\)/);
      out.push(
        <a key={`${keyPrefix}a${k++}`} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="mm-md">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = `h${Math.min(6, b.level)}`;
          return React.createElement(
            Tag,
            { key: i, className: `mm-md-h mm-md-h${b.level}` },
            renderInline(b.text, `h${i}-`)
          );
        }
        if (b.type === 'para') {
          return <p key={i} className="mm-md-p">{renderInline(b.text, `p${i}-`)}</p>;
        }
        if (b.type === 'ul') {
          return (
            <ul key={i} className="mm-md-ul">
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, `li${i}-${j}-`)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === 'ol') {
          return (
            <ol key={i} className="mm-md-ol">
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, `li${i}-${j}-`)}</li>
              ))}
            </ol>
          );
        }
        if (b.type === 'quote') {
          return <blockquote key={i} className="mm-md-q">{renderInline(b.text, `q${i}-`)}</blockquote>;
        }
        if (b.type === 'code') {
          return (
            <pre key={i} className="mm-md-pre"><code>{b.text}</code></pre>
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── Response card (stacked above A) ───────────────────────
// Each B card carries its own prompt as a faint header line so the user can
// scan the thread at a glance. Newest gets `data-newest`, which the CSS uses
// to scale it up slightly and brighten the accent — a subtle "you're looking
// at the latest result" cue. The body renders the full markdown returned
// by the orchestrator — never concised. The mindmap is the place to
// categorize visually; this card shows you everything the agents wrote.
function StackedResponse({ entry, isNewest, isOlder, stackIndex }) {
  return (
    <div
      className={'mm-stacked-response' + (isNewest ? ' newest' : '') + (isOlder ? ' older' : '')}
      data-newest={isNewest ? 'true' : 'false'}
      style={{ '--stack-i': stackIndex }}
    >
      <div className="mm-stacked-meta">
        <span className="mm-stacked-prompt">› {entry.prompt}</span>
        {entry.plan && (
          <span className="mm-stacked-plan">
            <span className="mm-stacked-plan-dot" />
            {entry.plan}
          </span>
        )}
      </div>
      <div className="mm-stacked-body">
        <Markdown text={entry.markdown || ''} />
      </div>
      <div className="mm-stacked-foot">
        <CopyButton getText={() => entry.markdown || ''} />
      </div>
    </div>
  );
}

// ─── Bar handle — the catalyst at the top of the canvas ───────
// A small subtle white pill that the user hovers/clicks/pulls. Trigger
// fires `onExpand()` which kicks off the bar-slide → collide → fountain
// choreography (orchestrated in `HeroMindmap`'s timeline).
function BarHandle({ onExpand, disabled, sliding, slideDistance }) {
  const [dragY, setDragY] = React.useState(0);
  const startY = React.useRef(0);
  const dragging = React.useRef(false);
  const fired = React.useRef(false);

  const onPointerDown = (e) => {
    if (disabled || sliding) return;
    dragging.current = true;
    fired.current = false;
    startY.current = e.clientY;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e) => {
    if (!dragging.current || fired.current) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDragY(Math.min(80, dy));
    if (dy > 48) {
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

  const progress = Math.min(1, dragY / 48);

  return (
    <button
      className={
        'mm-bar-handle' +
        (disabled ? ' disabled' : '') +
        (sliding ? ' sliding' : '')
      }
      onClick={disabled || sliding ? undefined : onExpand}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        transform: sliding ? undefined : `translateY(${dragY}px)`,
        '--bar-slide-distance': slideDistance ? `${slideDistance}px` : '30vh',
      }}
      aria-label="Initiate"
    >
      {!sliding && dragY > 0 && (
        <span className="mm-bar-progress">
          <span className="mm-bar-progress-fill" style={{ width: progress * 100 + '%' }} />
        </span>
      )}
    </button>
  );
}

// ─── Catalyst overlay (collide + shatter + fountain) ─────────
// Renders during the 'collapsing' phase, on top of the response stack.
// Drives the choreography:
//   stage 1 (0–420 ms): bar slides DOWN (handled by BarHandle.sliding)
//   stage 2 (420–920 ms): tokens fly in horizontally and collide
//   stage 3 (920–1170 ms): impact flash; A locks; B shatters into dots
//   stage 4 (1170–1900 ms): particles fountain downward with white
//                          vector trails, scaling up as they descend
// Parent transitions phase → 'mindmap' at t≈1900ms.

// ─── Shared orbital layout ────────────────────────────────────
// Used by BOTH the catalyst (so fountain particles end exactly where the
// real nodes will mount) and the settled orbital mindmap. Pure function —
// given nodes + stage size, returns the same positions on every call.
//
// Steps:
//   1. Polar placement: full 360° around A with seeded per-node random
//      angle + radius jitter, starting at 12 o'clock.
//   2. Overlap-resolver: iterative AABB repulsion — node↔node + node↔composer
//      rectangle. Enforces the no-overlap invariant.
const ORBIT_LAYOUT_CONSTS = {
  NODE_W: 220,
  NODE_H: 200,
  COMPOSER_HALF_W: 190,
  COMPOSER_HALF_H: 80,
  EDGE_PAD: 14,
  OVERLAP_GAP: 14,
};

function computeOrbitalLayout(nodes, stageW, stageH) {
  const n = nodes.length;
  if (n === 0 || stageW === 0) return [];

  const {
    NODE_W, NODE_H, COMPOSER_HALF_W, COMPOSER_HALF_H, EDGE_PAD, OVERLAP_GAP,
  } = ORBIT_LAYOUT_CONSTS;

  const cx = stageW / 2;
  const cy = stageH / 2;
  const minR = COMPOSER_HALF_W + NODE_W / 2 - 40;
  const maxR_x = cx - NODE_W / 2 - EDGE_PAD;
  const maxR_y = cy - NODE_H / 2 - EDGE_PAD;
  const baseR = Math.max(minR, Math.min(maxR_x, maxR_y, 320));

  // Seeded RNG so positions are stable across re-renders.
  const seedFor = (i) => {
    let h = 17;
    const k = nodes[i].key;
    for (let j = 0; j < k.length; j++) h = (h * 31 + k.charCodeAt(j)) | 0;
    return Math.abs(h);
  };
  const rand = (i, off) => {
    const s = (seedFor(i) + off * 1009) % 10000;
    return s / 10000;
  };

  const pos = nodes.map((node, i) => {
    const baseAngle = (i / n) * Math.PI * 2;
    const angleJitter = (rand(i, 1) - 0.5) * (Math.PI / n) * 0.6;
    const radiusJitter = (rand(i, 2) - 0.5) * 50;
    const angle = baseAngle + angleJitter - Math.PI / 2;
    const radius = baseR + radiusJitter;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const driftX = (rand(i, 3) - 0.5) * 8;
    const driftY = (rand(i, 4) - 0.5) * 8;
    const driftDur = 6 + rand(i, 5) * 4;
    const driftDelay = rand(i, 6) * 3;
    return { x, y, driftX, driftY, driftDur, driftDelay };
  });

  // Overlap resolver — node↔node, node↔composer, stage clamp.
  const COMP_W = COMPOSER_HALF_W * 2;
  const COMP_H = COMPOSER_HALF_H * 2;
  const minDx = NODE_W + OVERLAP_GAP;
  const minDy = NODE_H + OVERLAP_GAP;
  const minX = NODE_W / 2 + EDGE_PAD;
  const maxX = stageW - NODE_W / 2 - EDGE_PAD;
  const minY = NODE_H / 2 + EDGE_PAD;
  const maxY = stageH - NODE_H / 2 - EDGE_PAD;

  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = minDx - Math.abs(dx);
        const overlapY = minDy - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = overlapX / 2 + 0.5;
            const sign = dx >= 0 ? 1 : -1;
            a.x -= sign * push; b.x += sign * push;
          } else {
            const push = overlapY / 2 + 0.5;
            const sign = dy >= 0 ? 1 : -1;
            a.y -= sign * push; b.y += sign * push;
          }
          moved = true;
        }
      }
    }
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      const dx = p.x - cx;
      const dy = p.y - cy;
      const overlapX = (NODE_W / 2 + COMP_W / 2 + OVERLAP_GAP) - Math.abs(dx);
      const overlapY = (NODE_H / 2 + COMP_H / 2 + OVERLAP_GAP) - Math.abs(dy);
      if (overlapX > 0 && overlapY > 0) {
        if (overlapX < overlapY) {
          p.x += (dx >= 0 ? 1 : -1) * (overlapX + 0.5);
        } else {
          p.y += (dy >= 0 ? 1 : -1) * (overlapY + 0.5);
        }
        moved = true;
      }
    }
    for (const p of pos) {
      const nx = Math.max(minX, Math.min(maxX, p.x));
      const ny = Math.max(minY, Math.min(maxY, p.y));
      if (nx !== p.x || ny !== p.y) { p.x = nx; p.y = ny; moved = true; }
    }
    if (!moved) break;
  }

  // Attach center coords so callers can draw lines to A.
  for (const p of pos) { p.cx = cx; p.cy = cy; }
  return pos;
}

const COLLAPSE_TIMELINE = {
  barSlide:      { start:    0, dur:  420 },
  tokensFly:     { start:  420, dur:  500 },  // tokens enter & travel
  impact:        { start:  920, dur:   90 },  // collision flash
  shatter:       { start: 1010, dur:  160 },  // particles spawn at center
  fountain:      { start: 1170, dur:  730 },  // arc to final positions
  total: 1900,
};

function CatalystOverlay({ newest, slideDistance, stageRect }) {
  const [t, setT] = React.useState(0);
  React.useEffect(() => {
    const start = performance.now();
    let raf;
    const tick = () => {
      const elapsed = performance.now() - start;
      setT(elapsed);
      if (elapsed < COLLAPSE_TIMELINE.total + 100) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const inWindow = (key) => {
    const w = COLLAPSE_TIMELINE[key];
    return t >= w.start && t <= w.start + w.dur;
  };
  const after = (key) => t >= COLLAPSE_TIMELINE[key].start + COLLAPSE_TIMELINE[key].dur;
  const progress = (key) => {
    const w = COLLAPSE_TIMELINE[key];
    return Math.max(0, Math.min(1, (t - w.start) / w.dur));
  };

  // The categories the newest response will explode into — derived from
  // the orchestrator's markdown by splitting on H2/H3 headings (or
  // chunking paragraphs if there are none). Each particle wears its own
  // label + preview during the fountain.
  const nodes = React.useMemo(
    () => (newest ? extractCategoriesFromMarkdown(newest.markdown || '') : []),
    [newest]
  );
  const n = nodes.length;

  // Tokens fly in from off-canvas; B (OUTPUT) enters from LEFT, A (MINDMAP)
  // from RIGHT. They accelerate (ease-in) toward the collision point and
  // disappear at impact (the anchor replaces them as a single element).
  const tokensP = progress('tokensFly');
  const tokensEased = tokensP * tokensP * tokensP;  // ease-in cubic
  const tokensVisible = t >= COLLAPSE_TIMELINE.tokensFly.start && t < COLLAPSE_TIMELINE.impact.start;
  // Final offset of 68 px = half token width + 2 px gap → tokens just
  // TOUCH at collision; nothing overlaps.
  const tokenAX = `calc(50% + ${(1 - tokensEased) * 60 + 68}px)`;
  const tokenBX = `calc(50% - ${(1 - tokensEased) * 60 + 68}px)`;

  // Impact moment — short ring.
  const flashVisible = inWindow('impact') || (t > COLLAPSE_TIMELINE.impact.start && t < COLLAPSE_TIMELINE.impact.start + 280);
  const flashP = (t - COLLAPSE_TIMELINE.impact.start) / 240;
  const flashScale = 0.6 + flashP * 0.7;
  const flashOpacity = Math.max(0, 1 - flashP) * (flashP > 0 ? 1 : 0);

  // Particle final positions — call the SAME shared layout function as
  // useOrbitalPositions so every particle lands at exactly the resting
  // position of its corresponding OrbitalNode (including any nudges from
  // the overlap-resolver pass). This is what makes the "mini grows into
  // big" transition seamless: nothing shifts at handoff.
  const particleFinals = React.useMemo(() => {
    if (!stageRect || !stageRect.w || n === 0) return [];
    const cx = stageRect.w / 2;
    const cy = stageRect.h / 2;
    const layout = computeOrbitalLayout(nodes, stageRect.w, stageRect.h);
    return layout.map((p) => {
      // Bezier midpoint biased outward so the trajectory arcs naturally.
      const dx = p.x - cx;
      const dy = p.y - cy;
      return {
        fx: dx,
        fy: dy,
        midX: dx * 0.45,
        midY: dy * 0.55,
      };
    });
  }, [n, stageRect?.w, stageRect?.h, nodes]);

  const fountainP = progress('fountain');
  const fountainEased = 1 - Math.pow(1 - fountainP, 2.6);  // ease-out

  const cx0 = stageRect ? stageRect.w / 2 : 0;
  const cy0 = stageRect ? stageRect.h / 2 : 0;

  // Helper — partial quadratic Bezier from t=0 to t=u via de Casteljau.
  // Two outputs:
  //   box  → bezier(u)           — where the box is drawn (its CENTER)
  //   d    → SVG path that ENDS just outside the box's edge along the
  //          tangent direction, so the line never visually crosses the
  //          box. We back the line off by the box's half-extent in the
  //          tangent direction by re-evaluating de Casteljau at a slightly
  //          smaller u_line.
  const partialBezier = (sx, sy, cx, cy, ex, ey, u, boxHalfW, boxHalfH) => {
    const evalAt = (uu) => {
      const a1x = sx + uu * (cx - sx);
      const a1y = sy + uu * (cy - sy);
      const b1x = cx + uu * (ex - cx);
      const b1y = cy + uu * (ey - cy);
      const endX = a1x + uu * (b1x - a1x);
      const endY = a1y + uu * (b1y - a1y);
      return { a1x, a1y, endX, endY };
    };
    const at = evalAt(u);
    // Tangent at u — derivative of quadratic Bezier.
    const omu = 1 - u;
    const tx = 2 * omu * (cx - sx) + 2 * u * (ex - cx);
    const ty = 2 * omu * (cy - sy) + 2 * u * (ey - cy);
    const tlen = Math.hypot(tx, ty) || 1;
    const ux = tx / tlen;
    const uy = ty / tlen;
    // Retreat from the box CENTER by min(hw/|ux|, hh/|uy|) — distance along
    // the tangent until we exit the box rectangle. Add a 2 px safety gap.
    const retreat = boxHalfW > 0 && boxHalfH > 0
      ? Math.min(
          boxHalfW / Math.max(0.05, Math.abs(ux)),
          boxHalfH / Math.max(0.05, Math.abs(uy))
        ) + 2
      : 0;
    // Convert retreat (in px) to a delta in parameter space. Tangent
    // magnitude tells us "stage-units per unit u".
    const deltaU = Math.min(u, retreat / Math.max(tlen, 0.01));
    const uLine = Math.max(0, u - deltaU);
    const line = evalAt(uLine);
    return {
      d: `M ${sx} ${sy} Q ${line.a1x} ${line.a1y} ${line.endX} ${line.endY}`,
      box: { x: at.endX, y: at.endY },
    };
  };

  return (
    <div className="mm-catalyst-overlay" aria-hidden="true">
      {/* Tokens fly in — labeled text boxes. */}
      {tokensVisible && (
        <>
          <div
            className="mm-collide-token mm-token-b"
            style={{
              left: tokenBX,
              top: `50%`,
              opacity: tokensP > 0.05 ? 1 : 0,
            }}
          >
            <span className="mm-token-tick" />
            <span>output</span>
          </div>
          <div
            className="mm-collide-token mm-token-a"
            style={{
              left: tokenAX,
              top: `50%`,
              opacity: tokensP > 0.05 ? 1 : 0,
            }}
          >
            <span className="mm-token-tick" />
            <span>mindmap</span>
          </div>
        </>
      )}

      {/* Impact ring */}
      {flashVisible && (
        <div
          className="mm-impact-flash"
          style={{
            opacity: flashOpacity,
            transform: `translate(-50%, -50%) scale(${flashScale.toFixed(2)})`,
          }}
        />
      )}

      {/* A anchor — appears at center after impact and stays through the
          fountain. Same labeled-box visual as the colliding A token. */}
      {t >= COLLAPSE_TIMELINE.impact.start && (
        <div className="mm-collide-token mm-token-a mm-anchor-a"
          style={{ left: '50%', top: '50%', opacity: 1, transform: 'translate(-50%, -50%)' }}
        >
          <span className="mm-token-tick" />
          <span>mindmap</span>
        </div>
      )}

      {/* Fountain — trails are drawn ONLY up to the OUTER EDGE of the
          particle's bounding box along the tangent direction. The line
          never visually crosses the box. */}
      {t >= COLLAPSE_TIMELINE.fountain.start && stageRect && particleFinals.length > 0 && (
        <svg
          className="mm-fountain-svg"
          width={stageRect.w} height={stageRect.h}
          viewBox={`0 0 ${stageRect.w} ${stageRect.h}`}
        >
          {particleFinals.map((p, i) => {
            const u = fountainEased;
            // Particle's current scale (matches the render below).
            const scale = 0.13 + 0.87 * u;
            // Half extents of the particle BOX at this scale (~220×110).
            const boxHalfW = 110 * scale + 2;
            const boxHalfH = 55 * scale + 2;
            const { d } = partialBezier(
              cx0, cy0,
              cx0 + p.midX, cy0 + p.midY,
              cx0 + p.fx, cy0 + p.fy,
              u, boxHalfW, boxHalfH
            );
            // Trail opacity — full through most of fountain; fades in
            // the last 18 % so it vanishes before the box morph completes.
            const trailOpacity = fountainP < 0.06
              ? 0
              : fountainP < 0.82
                ? 0.5
                : Math.max(0, (1 - (fountainP - 0.82) / 0.18)) * 0.5;
            return (
              <path key={i} d={d} style={{ opacity: trailOpacity }} />
            );
          })}
        </svg>
      )}

      {/* Particles — mini text-box previews of the eventual nodes. They
          start tiny at the collision point and grow into the full-size
          card. The last ~15 % of fountain plays a "blur + expand" exit
          so the handoff to the real OrbitalNode reads as the box growing
          into focus, not popping in. */}
      {t >= COLLAPSE_TIMELINE.shatter.start && stageRect && particleFinals.length > 0 &&
        particleFinals.map((p, i) => {
          const inShatter = t < COLLAPSE_TIMELINE.fountain.start;
          let px, py;
          let scale, blur, opacity;
          if (inShatter) {
            // Cluster around the impact point with a small organic offset.
            const shatterP = progress('shatter');
            const ang = ((i / n) * Math.PI * 2) - Math.PI / 2;
            const cr = 20 + shatterP * 26;
            px = cx0 + Math.cos(ang) * cr;
            py = cy0 + Math.sin(ang) * cr;
            scale = 0.08 + shatterP * 0.05;
            blur = 0;
            opacity = 1;
          } else {
            // Travel along bezier; box position uses the SAME de Casteljau
            // evaluation as the trail's tangent-retreat origin, so the
            // trail endpoint and the box outer-edge meet exactly.
            const u = fountainEased;
            const { box } = partialBezier(
              cx0, cy0,
              cx0 + p.midX, cy0 + p.midY,
              cx0 + p.fx, cy0 + p.fy,
              u, 0, 0
            );
            px = box.x; py = box.y;
            scale = 0.13 + 0.87 * u;
            // Exit transition in the last 15 % of fountain — particle
            // expands (scale up by ~12 %), blurs, and fades. The real
            // OrbitalNode entrance picks up here.
            const exitP = Math.max(0, Math.min(1, (fountainP - 0.85) / 0.15));
            scale = scale + exitP * 0.12;
            blur = exitP * 6;
            opacity = 1 - exitP * exitP;  // ease-in fade (slow start)
          }
          const node = nodes[i] || {};
          const preview = previewTextForNode(node);
          return (
            <div
              key={i}
              className="mm-particle"
              style={{
                left: px, top: py,
                opacity,
                filter: blur ? `blur(${blur.toFixed(1)}px)` : undefined,
                transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
              }}
            >
              <div className="mm-particle-label">{node.label || '·'}</div>
              {preview && <div className="mm-particle-preview">{preview}</div>}
            </div>
          );
        })
      }
    </div>
  );
}

// Pull a short preview string from a node for the mini-card preview.
// Templates store different shapes, so we try a few common keys.
function previewTextForNode(node) {
  if (!node) return '';
  // Try to use the body's first line of text by inspecting the React
  // children — but to stay simple we encode preview hints via the
  // already-built copyText (which all extractors set).
  const text = (node.copyText || '').trim();
  if (!text) return '';
  // Strip any leading heading marker / mono ticks, take the first 80 chars.
  const cleaned = text
    .replace(/^[#>\-]+\s*/, '')
    .replace(/^\/\/\s*/, '')
    .split('\n')
    .find((ln) => ln.trim().length > 0) || '';
  return cleaned.length > 90 ? cleaned.slice(0, 90) + '…' : cleaned;
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
          One orchestrator routes your prompt across five specialized agents —
          plan, dispatch, synthesize. The full reply lands as formatted
          markdown; pull the bar handle to expand it into a visual mindmap.
        </p>
      </div>
      <div className="mm-composer-wrap">
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus />
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

  const olderEntries = ordered.slice(0, -1); // oldest → second-most-recent
  const newestEntry = ordered[ordered.length - 1] || null;

  return (
    <div
      className={
        'mm-phase mm-phase-response' +
        (collapsing ? ' collapsing' : '') +
        (entering ? ' entering' : '')
      }
    >
      <div className="mm-stack-wrap" style={{ '--stack-size': ordered.length }}>
        <div className="mm-stack-hint-slot">
          <BarHandle
            onExpand={expand}
            disabled={imploding || ordered.length === 0}
            sliding={collapsing}
            slideDistance={null /* CSS variable default */}
          />
        </div>
        <div className="mm-stack-list">
          {/* Tools row — anchored at the top of the list area, OUTSIDE the
              fading older block so the count + reset stay readable. */}
          {ordered.length > 0 && (
            <div className="mm-stack-tools-row">
              <button className="mm-reset" onClick={reset} title="New thread — wipes the response stack">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
                  <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
                </svg>
                <span>new thread</span>
              </button>
              <span className="mm-stack-count">{ordered.length} {ordered.length === 1 ? 'response' : 'responses'}</span>
            </div>
          )}
          {/* Older entries: positioned above the centered newest. DOM order
              is chronological (oldest first); flex-column with
              justify-content:flex-end lays them out top-down so the
              second-most-recent sits closest to the newest. Anything older
              fades upward and can scroll. */}
          {olderEntries.length > 0 && (
            <div className="mm-stack-older">
              {olderEntries.map((entry, i) => (
                <StackedResponse
                  key={entry.id}
                  entry={entry}
                  isNewest={false}
                  isOlder={true}
                  stackIndex={olderEntries.length - i}
                />
              ))}
            </div>
          )}
          {/* Newest entry: absolutely centered both axes in the list area. */}
          {newestEntry && (
            <div className="mm-stack-newest">
              <StackedResponse
                key={newestEntry.id}
                entry={newestEntry}
                isNewest={true}
                isOlder={false}
                stackIndex={0}
              />
            </div>
          )}
        </div>
        <div className="mm-stack-composer-slot">
          <Composer value={draft} onChange={setDraft} onSubmit={submit} />
        </div>
      </div>
    </div>
  );
}

// Orbital mindmap.
// Layout: an active composer (A) at the geometric center of the stage; one
// node per categorized chunk of the newest response (sections / files /
// targets / phases) positioned around A via polar coords with a per-node
// random jitter to read as a loose force-directed cluster rather than a
// rigid ring. Each node connects back to A by an SVG line drawn behind.
// Nodes drift gently after mount; the lines do NOT track the drift (the
// drift is sub-10px so the visual cost is hidden).
//
// Submitting from the center composer re-uses the parent's `submit()` — the
// mindmap unmounts naturally as the parent flips to `loading` and back to
// `response`. Clicking collapse plays an implode (lines + nodes converge
// to center) and returns to the response stack.

function useOrbitalPositions(nodes, stageRef) {
  const [positions, setPositions] = React.useState([]);
  const [size, setSize] = React.useState({ w: 0, h: 0 });

  React.useEffect(() => {
    if (!stageRef.current) return;
    const update = () => {
      const r = stageRef.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [stageRef]);

  React.useEffect(() => {
    if (nodes.length === 0 || size.w === 0) { setPositions([]); return; }
    setPositions(computeOrbitalLayout(nodes, size.w, size.h));
  }, [nodes, size.w, size.h]);

  return { positions, size };
}

function OrbitalLines({ positions, size }) {
  if (!size.w || positions.length === 0) return null;
  return (
    <svg className="mm-orbit-lines" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
      <defs>
        <radialGradient id="mm-orbit-line-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.05" />
        </radialGradient>
      </defs>
      {positions.map((p, i) => (
        <line
          key={i}
          x1={p.cx} y1={p.cy} x2={p.x} y2={p.y}
          stroke="url(#mm-orbit-line-grad)"
          strokeWidth="1"
          strokeDasharray="3 6"
          style={{
            opacity: 0,
            animation: `mmOrbitLineIn 600ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards`,
            animationDelay: `${220 + i * 60}ms`,
          }}
        />
      ))}
    </svg>
  );
}

function OrbitalNode({ node, pos, index }) {
  return (
    <div
      className={'mm-orbit-node mm-orbit-node-' + node.kind}
      style={{
        left: pos.x,
        top: pos.y,
        '--drift-x': pos.driftX + 'px',
        '--drift-y': pos.driftY + 'px',
        '--drift-dur': pos.driftDur + 's',
        '--drift-delay': pos.driftDelay + 's',
        '--burst-delay': (180 + index * 70) + 'ms',
        animationDelay: `${180 + index * 70}ms, ${1200 + pos.driftDelay * 1000}ms`,
      }}
    >
      <div className="mm-orbit-head">
        <span className="mm-orbit-label">{node.label}</span>
        {node.sub && <span className="mm-orbit-sub">{node.sub}</span>}
        <CopyButton tiny getText={() => node.copyText} />
      </div>
      {node.body}
    </div>
  );
}

function OrbitalMindmap({
  responses, collapse, reset, phase,
  draft, setDraft, submit,
}) {
  const newest = responses[responses.length - 1];
  const stageRef = React.useRef(null);
  const nodes = React.useMemo(
    () => (newest ? extractCategoriesFromMarkdown(newest.markdown || '') : []),
    [newest]
  );
  const { positions, size } = useOrbitalPositions(nodes, stageRef);

  if (!newest) return null;
  const imploding = phase === 'imploding';

  return (
    <div className={'mm-phase mm-phase-orbital' + (imploding ? ' imploding' : '')}>
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
          <span className="mm-thread-template">
            <i />{nodes.length} {nodes.length === 1 ? 'category' : 'categories'}
          </span>
        </div>
        <div className="mm-thread-actions">
          <span className="mm-thread-counter">{responses.length} in thread</span>
          <CopyButton getText={() => newest.markdown || ''} />
          <button className="mm-thread-reset" onClick={reset} title="New thread">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
              <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
            </svg>
            <span>new</span>
          </button>
        </div>
      </div>

      <div className="mm-orbit-stage" ref={stageRef}>
        <OrbitalLines positions={positions} size={size} />

        {/* The composer A — center, active. Same submit pipeline as the
            stack view, so a new prompt from here lands as a new B in the
            stack the moment we return to the response phase. */}
        <div className="mm-orbit-center">
          <span className="mm-orbit-center-tag">A · composer</span>
          <Composer value={draft} onChange={setDraft} onSubmit={submit} />
        </div>

        {positions.map((pos, i) => (
          <OrbitalNode key={nodes[i].key} node={nodes[i]} pos={pos} index={i} />
        ))}
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────
// v3: response stack now holds full markdown from the orchestrator (no
// JSON schema). v2 entries (template/data/text) are silently dropped on
// load because the rendering logic changed.
const STACK_LS_KEY = 'lattice.responseStack.v3';

const IMPLODE_DURATION_MS = 440;

function loadPersistedStack() {
  try {
    const raw = localStorage.getItem(STACK_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) =>
      e && typeof e.id === 'string' && typeof e.prompt === 'string' &&
      typeof e.markdown === 'string'
    );
  } catch { return []; }
}
function savePersistedStack(responses) {
  try {
    const slim = responses.map((r) => ({
      id: r.id, prompt: r.prompt, markdown: r.markdown,
      servedBy: r.servedBy || null, plan: r.plan || null,
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
  const stageRef = React.useRef(null);
  const [stageRect, setStageRect] = React.useState({ w: 0, h: 0 });

  React.useEffect(() => {
    if (!stageRef.current) return;
    const update = () => {
      // mm-stage has no padding/border, so getBoundingClientRect gives the
      // exact coordinate area both the catalyst overlay and the orbital
      // stage paint into.
      const r = stageRef.current.getBoundingClientRect();
      setStageRect({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, []);

  const newest = responses[responses.length - 1] || null;
  const accent = 'var(--accent)';

  // One persistent ChatSession per browser tab — same orchestrator-driven
  // smart routing the CLI's `task` / `chat` commands use. Responses come
  // back as full natural markdown (no JSON schema). The mindmap takes
  // that markdown and categorizes it visually, but the response itself is
  // never concised — what you see in B is what the orchestrator wrote.
  const sessionId = React.useMemo(() => {
    const KEY = 'lattice.sessionId.v1';
    let sid = null;
    try { sid = localStorage.getItem(KEY); } catch {}
    if (!sid) {
      sid = 'web_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(KEY, sid); } catch {}
    }
    return sid;
  }, []);

  const submit = async () => {
    const q = draft.trim();
    if (!q) return;
    setCurrentPrompt(q);
    setDraft('');
    setPhase('loading');

    const makeEntry = (markdown, meta = {}) => ({
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      prompt: q,
      markdown,
      ...meta,
    });

    try {
      // /api/chat → smart-routed orchestrator response (direct / single /
      // parallel plan, with fanout + synthesis). Same code path as CLI's
      // `task` command. Reply is natural markdown.
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: q }),
      });
      if (!res.ok) throw new Error(`/api/chat ${res.status}`);
      const json = await res.json();
      if (typeof json.reply !== 'string') throw new Error('bad response shape');
      const markdown = json.reply.trim();
      const entry = makeEntry(markdown, {
        servedBy: json.servedBy || null,
        plan: json.plan || null,
      });
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    } catch (e) {
      // Soft fallback so the UI doesn't get stuck on transient failures.
      const entry = makeEntry(
        `_Couldn't reach the orchestrator._\n\n**Error:** ${e?.message || 'unknown'}\n\nCheck that your \`.env\` has a real \`GEMINI_KEY_1\` (or another provider key) and try again.`,
        { servedBy: null, plan: null }
      );
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    }
  };

  // The catalyst sequence: bar slides → tokens collide → B shatters →
  // fountain settles. The CatalystOverlay drives the visuals from a single
  // animation timeline (`COLLAPSE_TIMELINE`). At the end (~1900 ms) we
  // switch to the mindmap phase where the settled nodes mount as real
  // OrbitalNode components in a fan layout.
  const expand = () => {
    if (phase !== 'response') return;
    setPhase('collapsing');
    setTimeout(() => setPhase('mindmap'), COLLAPSE_TIMELINE.total);
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
    // Also wipe the server-side chat session so the next thread starts
    // with no prior context. Fire-and-forget — UI doesn't wait on it.
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' })
      .catch(() => {});
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

      <div
        ref={stageRef}
        className="mm-stage"
        data-phase={phase}
        style={{ '--accent': accent }}
      >
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
        {phase === 'collapsing' && (
          <CatalystOverlay
            newest={newest}
            stageRect={stageRect}
            slideDistance={stageRect.h ? stageRect.h * 0.36 : 200}
          />
        )}
        {phase === 'mindmap' && (
          <OrbitalMindmap
            responses={responses}
            collapse={collapse} reset={reset} phase={phase}
            draft={draft} setDraft={setDraft} submit={submit}
          />
        )}
      </div>
    </div>
  );
}

window.HeroMindmap = HeroMindmap;
// Exposed so templates.jsx's MarkdownPreview can use the same renderer
// without a module system. (Order doesn't matter — templates.jsx looks
// it up at call time, not import time.)
window.Markdown = Markdown;
