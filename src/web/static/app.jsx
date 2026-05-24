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

// Agent roster colors — muted "ink palette" tuned for the warm Atelier
// theme. Each color sits on the same lightness band so they read as
// peer agents, distinguished by hue (amber → sage → mauve → olive →
// terracotta) without going neon.
const MM_AGENTS = [
  { id: 'orchestration',     name: 'Orchestrator', color: 'oklch(0.80 0.11 65)',  quota: 128000 },
  { id: 'perception',        name: 'Perception',   color: 'oklch(0.78 0.08 165)', quota: 128000 },
  { id: 'reasoning',         name: 'Reasoning',    color: 'oklch(0.78 0.08 330)', quota: 128000 },
  { id: 'action-code',       name: 'Coder',        color: 'oklch(0.78 0.08 130)', quota: 128000 },
  { id: 'action-structural', name: 'Structural',   color: 'oklch(0.76 0.10 35)',  quota: 128000 },
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

function Sidebar({ phase, latestResponse, open }) {
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
    <aside className={'mm-sidebar' + (open ? ' open' : '')}>
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
          const role = (usage.roles || {})[a.id];
          // Prefer the live remainingPct from /api/usage.json when the
          // provider declared an estimatedDailyBudget; fall back to the
          // local synthetic count / quota when it doesn't.
          const hasReal = role && typeof role.remainingPct === 'number';
          const usedPct = hasReal
            ? Math.max(0, 100 - role.remainingPct)
            : Math.min(100, (u / a.quota) * 100);
          return (
            <div key={a.id} className="mm-bar-row" style={{ '--c': a.color }}>
              <span className="label">{a.name.toLowerCase()}</span>
              <span className="bar"><span className="fill" style={{ width: usedPct + '%' }} /></span>
              <span className="num" title={hasReal ? `${role.remainingPct.toFixed(0)}% of daily budget remaining` : `~${CompactNumber(u)} tokens (estimated)`}>
                {usedPct.toFixed(0)}%
              </span>
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
              <div className="dim">routing[{latestResponse?.template || 'auto'}]</div>
            </>
          )}
          {phase === 'response' && (
            <>
              <div style={{ color: 'oklch(0.85 0.10 195)' }}>› synthesized</div>
              <div className="dim">template={latestResponse?.template}</div>
            </>
          )}
          {(phase === 'mindmap' || phase === 'collapsing' || phase === 'imploding') && (
            <>
              <div style={{ color: 'var(--accent)' }}>› burst expanded</div>
              <div className="dim">sections={
                (latestResponse?.data?.sections?.length
                  || latestResponse?.data?.files?.length
                  || latestResponse?.data?.targets?.length
                  || latestResponse?.data?.phases?.length) || 0
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
  // When autoFocus is on AND the textarea already has content (focused-node
  // prefill case), place the caret at the END of the value so the user can
  // start typing immediately after "For the X part: ".
  React.useEffect(() => {
    if (!autoFocus) return;
    const ta = ref.current; if (!ta) return;
    ta.focus();
    const end = ta.value.length;
    try { ta.setSelectionRange(end, end); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);
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
// One turn in the chat-style scroll view. User prompt on top
// (right-aligned), AI response below (left-aligned). The AI bubble
// renders the orchestrator's RAW prose answer (no category split —
// that's the mindmap's job). Newest gets a subtle accent ring.
function ChatTurn({ entry, accent, isNewest }) {
  const tpl = TEMPLATE_DEFS[entry.template];
  return (
    <div
      className={'mm-turn' + (isNewest ? ' newest' : '')}
      style={{ '--accent': accent }}
    >
      <div className="mm-turn-user">
        <span className="mm-turn-role">you</span>
        <div className="mm-turn-user-bubble">{entry.prompt}</div>
      </div>
      <div className="mm-turn-ai">
        <span className="mm-turn-role">
          orchestrator
          <span className="mm-turn-pill">
            <span className="mm-template-dot" />
            {tpl?.label || entry.template}
          </span>
        </span>
        <div className="mm-turn-ai-bubble">
          <MarkdownProse text={entry.text || ''} />
          <div className="mm-turn-foot">
            <CopyButton getText={() => entry.text || ''} />
          </div>
        </div>
      </div>
    </div>
  );
}

function InlineMarkdown({ text }) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => typeof p === 'string' ? <React.Fragment key={i}>{p}</React.Fragment> : p)}</>;
}

function MarkdownProse({ text }) {
  const blocks = parseMarkdownBlocks(text || '');
  return (
    <div className="mm-turn-prose">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = `h${Math.min(4, Math.max(2, b.level))}`;
          return <Tag key={i}><InlineMarkdown text={b.text} /></Tag>;
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return <Tag key={i}>{b.items.map((x, j) => <li key={j}><InlineMarkdown text={x} /></li>)}</Tag>;
        }
        if (b.type === 'code') return <pre key={i}><code>{b.text}</code></pre>;
        if (b.type === 'table') {
          return (
            <div key={i} className="mm-md-table-wrap">
              <table>
                <thead><tr>{b.headers.map((h, j) => <th key={j}><InlineMarkdown text={h} /></th>)}</tr></thead>
                <tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((c, j) => <td key={j}><InlineMarkdown text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={i}><InlineMarkdown text={b.text} /></p>;
      })}
    </div>
  );
}

function parseMarkdownBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isTableSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());

  while (i < lines.length) {
    const line = lines[i] || '';
    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line.trim())) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test((lines[i] || '').trim())) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (i + 1 < lines.length && line.includes('|') && isTableSep(lines[i + 1] || '')) {
      const headers = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && (lines[i] || '').includes('|') && (lines[i] || '').trim()) {
        rows.push(cells(lines[i] || ''));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length) {
        const m = (lines[i] || '').match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
        if (!m) break;
        items.push(m[1].trim());
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const para = [line.trim()];
    i++;
    while (
      i < lines.length &&
      (lines[i] || '').trim() &&
      !/^(#{1,4})\s+/.test(lines[i] || '') &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i] || '') &&
      !/^```/.test((lines[i] || '').trim()) &&
      !(i + 1 < lines.length && (lines[i] || '').includes('|') && isTableSep(lines[i + 1] || ''))
    ) {
      para.push((lines[i] || '').trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

function StackedResponse({ entry, accent, isNewest, isOlder, stackIndex }) {
  const tpl = TEMPLATE_DEFS[entry.template];
  // Render the full structured response (every section / file / target /
  // phase) — this is the "chat AI" view. The summary text stays as a lead
  // paragraph above it. Mindmap is one click away for the structured grid.
  const Renderer = RENDERERS[entry.template];
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
      {entry.text && (
        <p className="mm-stacked-summary">{entry.text}</p>
      )}
      <div className="mm-stacked-full">
        {Renderer && entry.data
          ? <Renderer data={entry.data} accent={accent} />
          : <div className="mm-stacked-body">{entry.text}</div>}
      </div>
      <div className="mm-stacked-foot">
        <CopyButton getText={() => formatResponseText(entry)} />
      </div>
    </div>
  );
}

// ─── Bar handle — explicit "burst into mindmap" affordance ─────
// Not an iOS pill. A wide horizontal seam labeled with double-chevron
// + text. Hover → label brightens + chevron animates downward; drag
// or click → fire onExpand. During the catalyst sequence (`sliding`)
// the bar slides down toward the collision point.
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
        'mm-seam-handle' +
        (disabled ? ' disabled' : '') +
        (sliding ? ' sliding' : '') +
        (dragY > 0 ? ' active' : '')
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
      aria-label="Burst into mindmap"
    >
      <span className="mm-seam-line" />
      <span className="mm-seam-knob">
        <svg viewBox="0 0 18 14" fill="none" aria-hidden="true">
          <path d="M3 3 L9 7 L15 3 M3 8 L9 12 L15 8"
            stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="mm-seam-label">burst into mindmap</span>
      </span>
      {!sliding && dragY > 0 && (
        <span className="mm-seam-progress" aria-hidden="true">
          <span className="mm-seam-progress-fill" style={{ width: progress * 100 + '%' }} />
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
// real nodes will mount) and the settled orbital mindmap.
//
// Strategy: explicit pre-computed angle table for branch counts 2..6
// (the realistic range — most templates produce 3-5). Larger counts fall
// back to evenly-spaced polar placement. Positions are then enforced not
// to overlap each other or the central composer rectangle by a final
// AABB pass, but with explicit angles that pass is usually a no-op.
//
// Box-edge intersections for connectors are computed by callers via
// `lineFromBoxToBox` below; the layout itself only returns centers.
const ORBIT_LAYOUT_CONSTS = {
  NODE_W: 220,
  NODE_H: 132,           // concise summary card — matches .mm-orbit-node max-height
  COMPOSER_HALF_W: 150,
  COMPOSER_HALF_H: 90,
  EDGE_PAD: 18,
  OVERLAP_GAP: 22,
  // The thread strip overlays the top of the orbit stage at top:12 + ~56px
  // strip height + 12 gap = ~80. Reserve it so top nodes don't crash into it.
  TOP_INSET: 92,
  BOTTOM_INSET: 18,
};

// Explicit angle tables (degrees from 12 o'clock, clockwise positive).
// Chosen so that:
//   - composer's east/west edges are never lined up with a node center
//     (so connectors don't overlap the composer corner)
//   - at every count, the visual weight is balanced top + bottom
//   - rotations were sketched on paper for each count rather than divided
//     evenly, so 2/3/4/5/6 each have their own deliberate shape.
const ANGLE_TABLES_DEG = {
  2: [-90, 90],                          // left + right
  3: [-90, 35, 145],                     // top + lower-right + lower-left
  4: [-65, 65, -115, 115],               // 4 corners (NE, SE, NW, SW — skips cardinals so nothing aligns)
  5: [-90, -28, 28, -150, 150],          // crown: 1 top + 2 upper-flank + 2 lower-flank
  6: [-90, -35, 35, -145, 145, 90],      // hexagonal: top, both upper, both lower, bottom
};

function anglesForCount(n) {
  if (ANGLE_TABLES_DEG[n]) return ANGLE_TABLES_DEG[n].map((d) => (d * Math.PI) / 180);
  // Fallback for outliers — even spacing starting at 12 o'clock.
  return Array.from({ length: n }, (_, i) => (i / n) * Math.PI * 2 - Math.PI / 2);
}

function computeOrbitalLayout(nodes, stageW, stageH) {
  const n = nodes.length;
  if (n === 0 || stageW === 0) return [];

  const {
    NODE_W, NODE_H, COMPOSER_HALF_W, COMPOSER_HALF_H, EDGE_PAD, OVERLAP_GAP,
    TOP_INSET, BOTTOM_INSET,
  } = ORBIT_LAYOUT_CONSTS;

  // The usable area for the orbit excludes the thread-strip overlay at the
  // top and a small bottom margin. We re-center the composer (and thus
  // the radial origin) into that usable area so the top node never
  // collides with the strip.
  const usableTop = TOP_INSET;
  const usableBottom = stageH - BOTTOM_INSET;
  const cx = stageW / 2;
  const cy = (usableTop + usableBottom) / 2;

  // Radius needs to keep the node box clear of the composer box. We size
  // it to the smaller of horizontal and vertical breathing room so even
  // narrow stages produce a clean layout.
  const minR = COMPOSER_HALF_W + NODE_W / 2 + OVERLAP_GAP - 30;
  const maxR_x = cx - NODE_W / 2 - EDGE_PAD;
  const maxR_y_top = cy - NODE_H / 2 - usableTop;       // top edge of usable
  const maxR_y_bot = usableBottom - cy - NODE_H / 2;    // bottom edge
  const maxR_y = Math.min(maxR_y_top, maxR_y_bot);
  const baseR = Math.max(minR, Math.min(maxR_x, maxR_y, 360));

  // Seeded RNG only for drift values (not for placement — placement is
  // now deterministic per branch count).
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

  const angles = anglesForCount(n);
  const pos = nodes.map((node, i) => {
    const angle = angles[i];
    const x = cx + Math.cos(angle) * baseR;
    const y = cy + Math.sin(angle) * baseR;
    const driftX = (rand(i, 3) - 0.5) * 8;
    const driftY = (rand(i, 4) - 0.5) * 8;
    const driftDur = 6 + rand(i, 5) * 4;
    const driftDelay = rand(i, 6) * 3;
    return { x, y, driftX, driftY, driftDur, driftDelay };
  });

  // Safety pass — should be a no-op for n<=6 but enforces invariant for
  // outliers or unusual stage sizes.
  const COMP_W = COMPOSER_HALF_W * 2;
  const COMP_H = COMPOSER_HALF_H * 2;
  const minDx = NODE_W + OVERLAP_GAP;
  const minDy = NODE_H + OVERLAP_GAP;
  const minX = NODE_W / 2 + EDGE_PAD;
  const maxX = stageW - NODE_W / 2 - EDGE_PAD;
  // Constrain Y to the usable area — never let a node climb into the
  // thread-strip zone at the top.
  const minY = usableTop + NODE_H / 2;
  const maxY = usableBottom - NODE_H / 2;
  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = minDx - Math.abs(dx);
        const oy = minDy - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const push = ox / 2 + 0.5;
            const sign = dx >= 0 ? 1 : -1;
            a.x -= sign * push; b.x += sign * push;
          } else {
            const push = oy / 2 + 0.5;
            const sign = dy >= 0 ? 1 : -1;
            a.y -= sign * push; b.y += sign * push;
          }
          moved = true;
        }
      }
    }
    for (const p of pos) {
      const dx = p.x - cx, dy = p.y - cy;
      const ox = (NODE_W / 2 + COMP_W / 2 + OVERLAP_GAP) - Math.abs(dx);
      const oy = (NODE_H / 2 + COMP_H / 2 + OVERLAP_GAP) - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox < oy) p.x += (dx >= 0 ? 1 : -1) * (ox + 0.5);
        else        p.y += (dy >= 0 ? 1 : -1) * (oy + 0.5);
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

  for (const p of pos) { p.cx = cx; p.cy = cy; }
  return pos;
}

// Given two AABB-defined rectangles (composer at center, node at p) and
// their centers, return the line endpoints that sit on each rectangle's
// EDGE along the line between centers. Used by OrbitalLines so the
// connector neither emerges from inside the composer nor punches into
// the node box.
function lineFromBoxToBox(cx, cy, nx, ny, compHalfW, compHalfH, nodeHalfW, nodeHalfH) {
  const dx = nx - cx, dy = ny - cy;
  if (dx === 0 && dy === 0) return { sx: cx, sy: cy, ex: nx, ey: ny };
  // Edge intersection of a ray from (0,0) with an AABB centered at origin.
  // t = how far along the ray (in normalized parameter) until we exit.
  const exitT = (hw, hh) => Math.min(hw / Math.max(0.01, Math.abs(dx)),
                                      hh / Math.max(0.01, Math.abs(dy)));
  const tComp = exitT(compHalfW, compHalfH);
  const tNode = 1 - exitT(nodeHalfW, nodeHalfH);
  return {
    sx: cx + dx * tComp,
    sy: cy + dy * tComp,
    ex: cx + dx * tNode,
    ey: cy + dy * tNode,
  };
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

  // The categories the newest response will explode into. We extract them
  // ahead of time so each particle can wear its own label + preview
  // during the fountain — particles aren't abstract dots, they're
  // miniature versions of the eventual nodes.
  const nodes = React.useMemo(
    () => (newest ? extractNodes(newest.template, newest.data) : []),
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
  // Trims BOTH ends so the visible line sits between the source box's
  // edge (the A token at center) and the particle box's edge along the
  // tangent direction. Returns:
  //   box  → bezier(u)            — where the particle box is drawn (its CENTER)
  //   d    → SVG path retreated at both ends
  const partialBezier = (sx, sy, cx, cy, ex, ey, u, boxHalfW, boxHalfH, srcHalfW = 0, srcHalfH = 0) => {
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
    // Tangent at u — derivative of quadratic Bezier — used to retreat
    // the END point from the particle box edge.
    const omu = 1 - u;
    const tx = 2 * omu * (cx - sx) + 2 * u * (ex - cx);
    const ty = 2 * omu * (cy - sy) + 2 * u * (ey - cy);
    const tlen = Math.hypot(tx, ty) || 1;
    const ux = tx / tlen;
    const uy = ty / tlen;
    const retreatEnd = boxHalfW > 0 && boxHalfH > 0
      ? Math.min(
          boxHalfW / Math.max(0.05, Math.abs(ux)),
          boxHalfH / Math.max(0.05, Math.abs(uy))
        ) + 2
      : 0;
    const deltaUEnd = Math.min(u, retreatEnd / Math.max(tlen, 0.01));
    const uLine = Math.max(0, u - deltaUEnd);
    const line = evalAt(uLine);

    // Tangent at u=0 — used to retreat the START point from the A-box edge
    // along the initial direction of the trail. Without this, the trail
    // visually emerges from inside the center A box.
    let startX = sx, startY = sy, startCtrlX = line.a1x, startCtrlY = line.a1y;
    if (srcHalfW > 0 && srcHalfH > 0) {
      const t0x = 2 * (cx - sx);   // dB/du at u=0
      const t0y = 2 * (cy - sy);
      const t0len = Math.hypot(t0x, t0y) || 1;
      const u0x = t0x / t0len;
      const u0y = t0y / t0len;
      const retreatStart = Math.min(
        srcHalfW / Math.max(0.05, Math.abs(u0x)),
        srcHalfH / Math.max(0.05, Math.abs(u0y)),
      ) + 2;
      const deltaUStart = Math.min(uLine, retreatStart / Math.max(t0len, 0.01));
      const startEval = evalAt(deltaUStart);
      startX = startEval.endX;
      startY = startEval.endY;
      // Recompute control point on the SHORTENED segment so the bezier
      // shape between start and end remains smooth.
      const subU = uLine - deltaUStart;
      if (subU > 0) {
        // The first-half control of the partial Q (de Casteljau a1 at uLine)
        // already approximates the new mid-handle; pull it slightly toward
        // the new startX/Y so the curve doesn't kink at the cut.
        startCtrlX = line.a1x + (startX - sx) * 0.4;
        startCtrlY = line.a1y + (startY - sy) * 0.4;
      }
    }
    return {
      d: `M ${startX} ${startY} Q ${startCtrlX} ${startCtrlY} ${line.endX} ${line.endY}`,
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
            // A-box (center "mindmap" anchor) half extents — width 132 +
            // padding ~24 → 156 total → halfW 78. Height ~28 → halfH 14.
            const aHalfW = 78;
            const aHalfH = 14;
            const { d } = partialBezier(
              cx0, cy0,
              cx0 + p.midX, cy0 + p.midY,
              cx0 + p.fx, cy0 + p.fy,
              u, boxHalfW, boxHalfH, aHalfW, aHalfH,
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

// Response view — normal vertical-scroll chat. Each turn is a row
// containing the user's prompt above the AI response card. The
// composer pins at the bottom; the BURST seam sits at the very top
// of the scroll area and operates on the NEWEST turn (the one the
// user just sent). New turns smooth-scroll into view.
function ResponseStackView({
  draft, setDraft, submit, responses, expand, reset, phase,
}) {
  const newest = responses[responses.length - 1];
  const accent = newest ? (TEMPLATE_DEFS[newest.template]?.accent || 'var(--accent)') : 'var(--accent)';
  const collapsing = phase === 'collapsing';
  const imploding = phase === 'imploding';

  // Smooth-scroll to the newest turn whenever it changes (new send,
  // initial mount with restored stack, or return from mindmap). Two
  // rAFs + a small setTimeout give React time to paint the new turn
  // AND its template renderer (which may itself be tall) before we
  // measure. lastIdRef starts as null so the effect fires on first
  // mount when there's a persisted stack.
  const listRef = React.useRef(null);
  const bottomRef = React.useRef(null);
  const lastIdRef = React.useRef(null);
  React.useEffect(() => {
    const list = listRef.current;
    const bottom = bottomRef.current;
    if (!list || !bottom) return;
    if (lastIdRef.current === newest?.id && !imploding) return;
    lastIdRef.current = newest?.id;
    const doScroll = () => {
      try {
        bottom.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } catch {
        list.scrollTop = list.scrollHeight;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(doScroll, 80)));
  }, [newest?.id, imploding, responses.length]);

  return (
    <div
      className={
        'mm-phase mm-phase-response mm-chat' +
        (collapsing ? ' collapsing' : '')
      }
      style={{ '--accent': accent }}
    >
      <div className="mm-chat-wrap">
        {responses.length > 0 && (
          <BarHandle
            onExpand={expand}
            disabled={imploding || responses.length === 0}
            sliding={collapsing}
            slideDistance={null}
          />
        )}
        <div className="mm-chat-list" ref={listRef}>
          {responses.length > 0 && (
            <div className="mm-chat-toolbar">
              <span className="mm-chat-count">
                {responses.length} {responses.length === 1 ? 'turn' : 'turns'}
              </span>
              <button className="mm-reset" onClick={reset} title="Clear conversation and start over">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M2.5 6a3.5 3.5 0 1 1 1.1 2.5" />
                  <path d="M2.5 3v2.5h2.5" strokeLinecap="round" />
                </svg>
                <span>new thread</span>
              </button>
            </div>
          )}
          {responses.map((entry, i) => (
            <ChatTurn
              key={entry.id}
              entry={entry}
              accent={TEMPLATE_DEFS[entry.template]?.accent || accent}
              isNewest={i === responses.length - 1}
            />
          ))}
          {/* Scroll anchor — scrollIntoView target so smooth-scroll
              survives heavy-render newest turns. */}
          <div ref={bottomRef} className="mm-chat-anchor" aria-hidden="true" />
        </div>
        <div className="mm-chat-composer">
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
  const { COMPOSER_HALF_W, COMPOSER_HALF_H, NODE_W, NODE_H } = ORBIT_LAYOUT_CONSTS;
  const nodeHalfW = NODE_W / 2;
  const nodeHalfH = NODE_H / 2;
  return (
    <svg className="mm-orbit-lines" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
      <defs>
        <radialGradient id="mm-orbit-line-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.05" />
        </radialGradient>
      </defs>
      {positions.map((p, i) => {
        // Connector terminates on BOTH boxes' edges so it never visually
        // pierces the composer or the node card.
        const { sx, sy, ex, ey } = lineFromBoxToBox(
          p.cx, p.cy, p.x, p.y,
          COMPOSER_HALF_W, COMPOSER_HALF_H,
          nodeHalfW, nodeHalfH,
        );
        return (
          <line
            key={i}
            x1={sx} y1={sy} x2={ex} y2={ey}
            stroke="url(#mm-orbit-line-grad)"
            strokeWidth="1"
            strokeDasharray="3 6"
            style={{
              opacity: 0,
              animation: `mmOrbitLineIn 600ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards`,
              animationDelay: `${220 + i * 60}ms`,
            }}
          />
        );
      })}
    </svg>
  );
}

function OrbitalNode({ node, pos, index, onFocus }) {
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
      onClick={(e) => {
        // Don't fire when the inner CopyButton is clicked.
        if (e.target.closest('.mm-copy')) return;
        if (onFocus) onFocus(node);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onFocus) {
          e.preventDefault();
          onFocus(node);
        }
      }}
    >
      <div className="mm-orbit-head">
        <span className="mm-orbit-label">{node.label}</span>
        {node.sub && <span className="mm-orbit-sub">{node.sub}</span>}
        <CopyButton tiny getText={() => node.copyText} />
      </div>
      {/* Render the concise summary in the mindmap; full body is reserved
          for the FocusedNodeView. */}
      {node.summaryBody || node.body}
      <span className="mm-orbit-expand-hint">click to expand</span>
    </div>
  );
}

// Focused-node view — covers the stage (sidebar untouched), composer
// slides up to the bottom strip and is pre-filled so the next message
// is scoped to this specific category.
function FocusedNodeView({ node, accent, onBack, draft, setDraft, submit }) {
  return (
    <div className="mm-focus-overlay" style={{ '--accent': accent }}>
      <div className="mm-focus-bar">
        <button className="mm-focus-back" onClick={onBack} title="Back to mindmap">
          <svg viewBox="0 0 16 12" fill="none">
            <path d="M7 2 L2 6 L7 10 M2 6 L14 6"
              stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>back to mindmap</span>
        </button>
        <span className="mm-focus-title">
          <i style={{ background: accent }} />
          <span className="lbl">{node.label}</span>
          {node.sub && <span className="sub">{node.sub}</span>}
        </span>
        <CopyButton getText={() => node.copyText} />
      </div>
      <div className={'mm-focus-card mm-orbit-node-' + node.kind}>
        <div className="mm-focus-body-scroll">
          {node.body}
        </div>
      </div>
      <div className="mm-focus-composer-wrap">
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus />
      </div>
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
    () => (newest ? extractNodes(newest.template, newest.data) : []),
    [newest]
  );
  const { positions, size } = useOrbitalPositions(nodes, stageRef);

  // Per-category focus state. Clicking a node sets `focused` and pre-fills
  // the composer with a scoped prompt prefix. Going back to the mindmap
  // clears focus and restores the draft to whatever the user had.
  const [focused, setFocused] = React.useState(null);
  const [savedDraft, setSavedDraft] = React.useState('');
  const openFocus = (node) => {
    setSavedDraft(draft);
    setFocused(node);
    setDraft(`For the ${node.label} part: `);
  };
  const closeFocus = () => {
    setFocused(null);
    setDraft(savedDraft);
  };

  if (!newest) return null;
  const accent = TEMPLATE_DEFS[newest.template]?.accent || 'var(--accent)';
  const imploding = phase === 'imploding';

  if (focused) {
    return (
      <FocusedNodeView
        node={focused}
        accent={accent}
        onBack={closeFocus}
        draft={draft} setDraft={setDraft} submit={submit}
      />
    );
  }

  return (
    <div className={'mm-phase mm-phase-orbital' + (imploding ? ' imploding' : '')}
      style={{ '--accent': accent }}>
      {/* Compact thread header — collapse moved OUT of here; this strip
          now just shows prompt + template + counter + reset. */}
      <div className="mm-thread-strip">
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

      <div className="mm-orbit-stage" ref={stageRef}>
        <OrbitalLines positions={positions} size={size} />

        {/* The composer A — center of the USABLE area (not stage center),
            so it shares the same origin the orbit layout uses. Without
            this offset the top node would crash into the thread strip. */}
        <div
          className="mm-orbit-center"
          style={positions[0]?.cy ? { top: positions[0].cy + 'px' } : undefined}
        >
          {/* Collapse sits directly above the composer so it lives where
              the user's hand already is after they dragged the bar down
              to reach the mindmap. */}
          <button className="mm-orbit-collapse" onClick={collapse} title="Collapse back to thread">
            <svg viewBox="0 0 16 10" fill="none">
              <path d="M2 8 L8 2 L14 8"
                stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>collapse to thread</span>
          </button>
          <span className="mm-orbit-center-tag">A · composer</span>
          <Composer value={draft} onChange={setDraft} onSubmit={submit} />
        </div>

        {positions.map((pos, i) => (
          <OrbitalNode key={nodes[i].key} node={nodes[i]} pos={pos} index={i} onFocus={openFocus} />
        ))}
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
  const stageRef = React.useRef(null);
  const [stageRect, setStageRect] = React.useState({ w: 0, h: 0 });
  // Mobile sidebar drawer (the desktop sidebar is hidden by media query).
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

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
  const accent = newest ? (TEMPLATE_DEFS[newest.template]?.accent || 'var(--accent)') : 'var(--accent)';

  // Shared HTTP helper for the same multi-agent orchestration path used
  // by `npm run cli -- task ...`.
  const taskApi = async (prompt) => {
    const res = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`/api/task ${res.status}`);
    const json = await res.json();
    if (typeof json.reply !== 'string') throw new Error('bad response shape');
    return json.reply;
  };

  // Submit a new chat turn. Sends the user's RAW prompt to the
  // orchestrator (no template-JSON wrapping) so the chat shows the
  // natural prose answer — exactly like Claude/ChatGPT. The
  // structured per-category breakdown is fetched lazily on burst
  // (see expand() below) so the chat phase costs one API call.
  const submit = async () => {
    const q = draft.trim();
    if (!q) return;
    const template = detectTemplate(q);
    setCurrentPrompt(q);
    setDraft('');
    setPhase('loading');

    try {
      const [reply] = await Promise.all([
        taskApi(q),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
      const entry = {
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        prompt: q,
        template,
        text: reply.trim(),
        data: null,            // lazy-loaded on burst
        dataLoading: false,
      };
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    } catch (e) {
      const entry = {
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        prompt: q,
        template,
        text: `(error: ${e.message || 'request failed'})`,
        data: null,
        dataLoading: false,
      };
      const next = [...responses, entry];
      setResponses(next);
      savePersistedStack(next);
      setPhase('response');
    }
  };

  // The catalyst sequence: bar slides -> tokens collide -> B shatters ->
  // fountain settles. Mindmap categories are derived locally from the
  // already-rendered markdown answer, so bursting does NOT spend a second
  // model call and cannot hang waiting for a categorization request.
  const expand = async () => {
    if (phase !== 'response') return;
    const newestEntry = responses[responses.length - 1];
    if (!newestEntry) return;
    const parsed = newestEntry.data ||
      deriveMindmapData(newestEntry.template, newestEntry.prompt, newestEntry.text);
    const next = responses.map((e) =>
      e.id === newestEntry.id ? { ...e, data: parsed } : e
    );
    setResponses(next);
    savePersistedStack(next);
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

      <Sidebar phase={phase} latestResponse={newest} open={sidebarOpen} />
      {/* Mobile-only quota/stats toggle. Hidden via media query >880px. */}
      <button
        className={'mm-sidebar-toggle' + (sidebarOpen ? ' active' : '')}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? 'Hide quota panel' : 'Show quota / agents'}
      >
        {sidebarOpen ? 'close' : 'quota'}
      </button>

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
