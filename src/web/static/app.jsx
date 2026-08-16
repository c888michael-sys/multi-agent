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

// ─── Agent-status accumulation (shared, data-layer) ──────────
// The streaming handler fires one ChatProgressEvent at a time
// (plan-start → plan → role-start perception → role-end perception
// → role-start reasoning → …). In round-robin mode the four
// role-start events arrive in a single network chunk, so the SSE
// reader's inner loop calls setLiveTurn() several times in one
// synchronous burst — React batches those, and a render-layer
// reducer (the old useState/useEffect approach) only ever sees the
// LAST event of the burst, blanking the earlier roles back to
// 'queued'. The fix is to accumulate in the DATA layer: a plain
// `agentAcc` object is mutated once per event directly inside the
// SSE loop (immune to React batching), and a fresh snapshot ships
// on `liveTurn.agentState` with every setLiveTurn. LoadingView then
// just renders that prop. These two pure helpers hold the logic so
// the SSE loop and any future consumer share one source of truth.
const BASE_TITLE = 'Lattice — multi-agent';
const IDLE_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0b0d'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23c9a15f'/%3E%3Cpath d='M16 5v5M16 22v5M5 16h5M22 16h5' stroke='%23f4f0e8' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E";
const BUSY_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0b0d'/%3E%3Ccircle cx='16' cy='16' r='8' fill='%237db4ff'/%3E%3Cpath d='M16 7v18M7 16h18' stroke='%23f4f0e8' stroke-width='1.7' stroke-linecap='round'/%3E%3C/svg%3E";

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setFavicon(href) {
  const el = document.getElementById('favicon');
  if (el) el.setAttribute('href', href);
}

function setBusyChrome(label) {
  if (typeof document === 'undefined') return;
  document.title = `● ${label || 'working'} — Lattice`;
  setFavicon(BUSY_FAVICON);
}

function resetChrome() {
  if (typeof document === 'undefined') return;
  document.title = BASE_TITLE;
  setFavicon(IDLE_FAVICON);
}

function CopyButton({ getText, tiny }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async (e) => {
    e?.stopPropagation?.();
    const text = typeof getText === 'function' ? getText() : '';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <button
      type="button"
      className={'mm-copy' + (tiny ? ' tiny' : '')}
      onClick={copy}
      title="Copy"
      aria-label="Copy"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="5" y="4" width="8" height="9" rx="1.5" />
        <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" />
      </svg>
      <span>{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

function makeInitialAgentMap() {
  return Object.fromEntries(
    MM_AGENTS.map((a) => [a.id, { state: 'queued', label: 'queued' }]),
  );
}

// Apply a single status event to the prior agent map, returning a new
// map (never mutates `prev`). `status` is the merged SSE frame shape
// `{ phase: evt.kind, ...evt }`, so `kind` is the outer event type
// (plan-start / plan / role-start / role-end) and `phase` is the inner
// sub-phase (single / parallel / synthesis / direct) when present.
function applyAgentEvent(prev, status) {
  if (!status) return makeInitialAgentMap();
  const { phase, role, kind, ok, plan } = status;
  // Prefer the outer event type over the inner sub-phase.
  const ph = kind || phase;
  // plan-start = new turn boundary — wipe and engage the orchestrator.
  if (ph === 'plan-start') {
    const fresh = makeInitialAgentMap();
    fresh['orchestration'] = { state: 'engaged', label: 'planning…' };
    return fresh;
  }
  const next = { ...prev };
  if (ph === 'plan') {
    next['orchestration'] = { state: 'engaged', label: `plan: ${plan?.kind || '?'}` };
    // Queue the specialists the plan will run — but DON'T overwrite a
    // specialist already 'engaged'/'done' from an earlier event (the
    // plan event can arrive after the first role-start over SSE).
    if (plan?.kind === 'single' && plan.role && next[plan.role]?.state === 'queued') {
      next[plan.role] = { state: 'queued', label: 'queued' };
    } else if (plan?.kind === 'parallel' && Array.isArray(plan.tasks)) {
      for (const t of plan.tasks) {
        if (next[t.role] && next[t.role].state === 'queued') {
          next[t.role] = { state: 'queued', label: 'queued' };
        }
      }
    }
  } else if (ph === 'role-start' && role) {
    if (next[role]) {
      if (phase === 'synthesis') {
        next[role] = { state: 'engaged', label: 'synthesizing…' };
      } else if (phase === 'direct') {
        next[role] = { state: 'engaged', label: 'answering directly…' };
      } else {
        next[role] = { state: 'engaged', label: 'thinking…' };
      }
    }
  } else if (ph === 'role-end' && role) {
    if (next[role]) {
      next[role] = ok === false
        ? { state: 'failed', label: 'failed' }
        : { state: 'done', label: '✓ done' };
    }
  }
  return next;
}

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
    const reduceMotion = prefersReducedMotion();
    const constellationRgb = getComputedStyle(canvas).getPropertyValue('--mm-constellation').trim() || '125,180,255';

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
      if (!reduceMotion) rafRef.current = requestAnimationFrame(render);
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
            ctx.strokeStyle = `rgba(${constellationRgb},${op + boost * 0.28})`;
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
        grad.addColorStop(0, `rgba(${constellationRgb},0.14)`);
        grad.addColorStop(0.5, `rgba(${constellationRgb},0.04)`);
        grad.addColorStop(1, `rgba(${constellationRgb},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, r1, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    render();
    const onResize = () => {
      resize();
      if (reduceMotion) render();
    };

    if (!reduceMotion) {
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mouseleave', onLeave);
    }
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="mm-canvas" />;
}

// ─── Sidebar ────────────────────────────────────────────────
// Format milliseconds-until-available as M:SS for sub-hour, Hh Mm for longer.
function formatCountdown(ms) {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `0:${String(secs).padStart(2, '0')}`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function CompactNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

// Pull the first balanced {…} block out of a model response and parse
// it as JSON. Strips <think>…</think> chain-of-thought blocks (used by
// reasoning models like DeepSeek-R1) and ```json fences first, then
// walks the remaining text tracking brace depth and JSON-string state
// so braces inside string literals don't confuse the scan. Returns the
// parsed object or null on any failure — the categorize pipeline treats
// null as "couldn't structure this reply" rather than silently rendering
// fictional fallback data.
//
// This used to be a single `replace(/```json|```/g, '').trim()` + JSON.parse,
// which broke as soon as any local model (qwen-coder especially) added
// a sentence of prose before or after the JSON — causing the mindmap to
// never activate in hybrid mode.
function extractFirstJsonObject(text) {
  if (!text) return null;
  let s = String(text);
  // 1) Strip <think>…</think> blocks (multi-line, case-insensitive) —
  //    DeepSeek-R1 and similar reasoning models emit these around their
  //    actual answer.
  s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
  // 2) Strip markdown code fences — both ```json and bare ```.
  s = s.replace(/```\s*json\s*/gi, '').replace(/```/g, '');
  // 3) Scan for the first balanced {…}.
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// Shared poller for /api/usage.json. Used by the sidebar (gauges +
// cooldown countdowns) and the quota-warning banner. Polling at 3 Hz is
// cheap and keeps the two views perfectly in sync.
function useUsage(extraDepKey, useLocal) {
  const [usage, setUsage] = React.useState({ roles: {}, mode: 'round-robin' });
  const [usageFetchedAt, setUsageFetchedAt] = React.useState(performance.now());
  // URL is rebuilt whenever the mode flips so the sidebar instantly
  // mirrors local↔cloud, not on the next 3 s poll only.
  const usageUrl = useLocal ? '/api/usage.json?local=1' : '/api/usage.json';
  React.useEffect(() => {
    let cancelled = false;
    const fetchUsage = async () => {
      try {
        const r = await fetch(usageUrl);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) {
          setUsage(j);
          setUsageFetchedAt(performance.now());
        }
      } catch {/* ignore */}
    };
    fetchUsage();
    const id = setInterval(fetchUsage, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [usageUrl]);
  // Optional one-shot refresh hook keyed on caller-supplied value
  // (e.g. phase change). Lets the banner refresh immediately when a
  // turn finishes, instead of waiting up to 3 s for the next poll.
  React.useEffect(() => {
    if (extraDepKey === undefined) return;
    fetch(usageUrl).then((r) => r.ok && r.json().then((j) => {
      setUsage(j); setUsageFetchedAt(performance.now());
    })).catch(() => {});
  }, [extraDepKey, usageUrl]);
  return { usage, usageFetchedAt };
}

// Local-model rows show ∞ in place of "0/9999" because Ollama imposes
// no cloud-style rate cap. Other providers fall through to the cap
// they were configured with.
function isLocalProvider(id) {
  return typeof id === 'string' && id.startsWith('ollama:');
}

function SystemStatus({ useLocal }) {
  const { usage } = useUsage(undefined, useLocal);
  const roles = usage.roles || {};
  if (Object.keys(roles).length === 0) {
    return (
      <div className={'mm-status' + (useLocal ? ' local' : '')} title="Waiting for usage snapshot">
        <i />{useLocal ? 'HYBRID SYNCING' : 'ROLES SYNCING'}
      </div>
    );
  }

  const total = MM_AGENTS.length;
  let unavailable = 0;
  let cooling = 0;
  let fallback = 0;

  for (const a of MM_AGENTS) {
    const role = roles[a.id];
    if (!role || role.registered === false || role.status === 'unavailable') {
      unavailable++;
    } else if (role.status === 'temporarily-unavailable' || role.cooling) {
      cooling++;
    } else if (role.fallback) {
      fallback++;
    }
  }

  const ready = Math.max(0, total - unavailable - cooling);
  const degraded = unavailable > 0 || cooling > 0 || fallback > 0;
  const label = useLocal
    ? `HYBRID ${ready}/${total} READY`
    : `${ready}/${total} ROLES READY`;
  const titleParts = [];
  if (fallback) titleParts.push(`${fallback} on fallback`);
  if (cooling) titleParts.push(`${cooling} cooling`);
  if (unavailable) titleParts.push(`${unavailable} unavailable`);

  return (
    <div
      className={'mm-status' + (degraded ? ' warn' : '') + (useLocal ? ' local' : '')}
      title={titleParts.length ? titleParts.join(', ') : 'All visible roles have a ready provider'}
    >
      <i />{label}
    </div>
  );
}

// QuotaBanner — one-line strip above the composer that warns when any
// role drops below 10 % remaining, falls back, becomes temporarily
// unavailable, or the conservation pool flips to serial mode. Renders
// nothing when everything is healthy so the chat surface stays clean.
//
// Data comes from /api/usage.json (same source the sidebar polls). The
// banner prioritizes the LOWEST-remaining role so users see the most
// urgent signal first; a "+N more" suffix appears if multiple roles
// are degraded simultaneously.
function QuotaBanner({ phase, useLocal }) {
  // Re-fetch when the phase changes so the banner reflects post-turn
  // state without waiting for the next 3 s poll.
  const { usage } = useUsage(phase, useLocal);
  const issues = React.useMemo(() => {
    const out = [];
    const roles = usage.roles || {};
    for (const a of MM_AGENTS) {
      const r = roles[a.id];
      if (!r) continue;
      // Hard-down: nothing in the role's chain can serve right now.
      if (r.status === 'unavailable') {
        out.push({ kind: 'unavailable', role: a, providerId: null, pct: 0 });
        continue;
      }
      // Soft-down: every candidate is cooling. The picked provider in
      // r.providerId is still the primary but it's cooling.
      if (r.status === 'temporarily-unavailable' || r.cooling) {
        out.push({ kind: 'cooling', role: a, providerId: r.providerId, pct: r.remainingPct ?? 0 });
        continue;
      }
      // Low-quota: the picked provider has < 10 % left. Includes the
      // case where r.fallback is true (we're already on a backup).
      if (typeof r.remainingPct === 'number' && r.remainingPct < 10) {
        out.push({
          kind: r.fallback ? 'fallback-low' : 'low',
          role: a, providerId: r.providerId, pct: r.remainingPct,
        });
        continue;
      }
      if (r.fallback) {
        out.push({ kind: 'fallback', role: a, providerId: r.providerId, pct: r.remainingPct ?? 100 });
      }
    }
    // Sort: hard-down first, then by lowest remaining %.
    out.sort((a, b) => {
      const rank = (k) => k === 'unavailable' ? 0 : k === 'cooling' ? 1 : k === 'low' ? 2 : k === 'fallback-low' ? 3 : 4;
      const r = rank(a.kind) - rank(b.kind);
      if (r !== 0) return r;
      return (a.pct || 0) - (b.pct || 0);
    });
    return out;
  }, [usage]);

  const serial = usage.mode === 'serial';
  if (!serial && issues.length === 0) return null;

  const lead = issues[0];
  const leadText = !lead ? null
    : lead.kind === 'unavailable'
      ? `${lead.role.name.toLowerCase()} has no provider available — turns to that role will fail`
    : lead.kind === 'cooling'
      ? `${lead.role.name.toLowerCase()} is cooling on every candidate; turns will block briefly`
    : lead.kind === 'fallback-low'
      ? `${lead.role.name.toLowerCase()} on fallback (${lead.providerId}) — only ${Math.round(lead.pct)} % left`
    : lead.kind === 'low'
      ? `${lead.role.name.toLowerCase()} (${lead.providerId}) at ${Math.round(lead.pct)} % — will rotate to next candidate soon`
    : `${lead.role.name.toLowerCase()} running on fallback (${lead.providerId})`;

  const more = issues.length > 1 ? ` +${issues.length - 1} more` : '';
  const serialTag = serial ? <span className="mm-quota-banner-serial">conservation: serial</span> : null;

  return (
    <div
      className={'mm-quota-banner mm-quota-' + (lead?.kind || (serial ? 'serial-only' : 'ok'))}
      role="status"
      aria-live="polite"
    >
      <span className="mm-quota-banner-dot" />
      {leadText && <span className="mm-quota-banner-msg">{leadText}{more}</span>}
      {!leadText && serial && <span className="mm-quota-banner-msg">conservation mode active — pool flipped to serial dispatch</span>}
      {leadText && serialTag}
    </div>
  );
}

// SettingsDrawer — slide-in panel from the right that exposes the
// CLI's runtime flags as web UI toggles:
//   • Serious / powerful mode  → adds `thinking: "high"` to every
//     underlying call (CLI: --serious / --thinking=high).
//   • Google Search grounding  → adds `useSearch: true`; Gemini uses native
//     grounding, and perception fallback models get web_search results.
//   • Force role               → bypasses smart routing for the next turn
//     and pins the call to a specific role's chain (CLI: --role=<name>).
// Settings persist to localStorage; HeroMindmap reads them per submit and
// includes them in the /api/chat-stream body. The chip in the nav reflects
// the *number of non-default* knobs so the user can tell at a glance
// whether anything is currently in effect.
const ROLE_INSTRUCTION_ROLES = [
  'perception',
  'reasoning',
  'orchestration',
  'action-code',
  'action-structural',
  'action-repetitive',
  'mindmap-categorize',
];

function normalizeRoleInstructionPayload(value) {
  const roles = {};
  for (const role of ROLE_INSTRUCTION_ROLES) {
    roles[role] = value && value.roles && typeof value.roles[role] === 'string'
      ? value.roles[role]
      : '';
  }
  return {
    version: 1,
    global: value && typeof value.global === 'string' ? value.global : '',
    roles,
  };
}

function roleInstructionPayloadsEqual(a, b) {
  return JSON.stringify(normalizeRoleInstructionPayload(a)) === JSON.stringify(normalizeRoleInstructionPayload(b));
}

function modelLabel(model) {
  if (!model) return 'unknown';
  const ctx = model.contextLength ? ` · ${CompactNumber(model.contextLength)} ctx` : '';
  const tag = model.reasoningCapable ? ' · reasoning' : '';
  return `${model.name || model.id}${tag}${ctx}`;
}

const ROLE_ROUTING_LABELS = {
  reasoning: 'Reasoning',
  orchestration: 'Orchestration',
  'action-code': 'Action · code',
  'action-structural': 'Action · structural',
  'action-repetitive': 'Action · repetitive',
};

// Per-role provider + model routing. Each customisable role can be pointed at
// any configured provider, then a model within it; clearing reverts to the
// default chain. Mirrors the CLI `models set/clear` and /api/role-model.
function ModelRoutingSection({ open }) {
  const [providers, setProviders] = React.useState([]);
  const [roles, setRoles] = React.useState([]);
  const [overrides, setOverrides] = React.useState({});
  const [roleProvider, setRoleProvider] = React.useState({});
  const [roleModels, setRoleModels] = React.useState({});
  const [roleModelMeta, setRoleModelMeta] = React.useState({});
  const [roleLoading, setRoleLoading] = React.useState({});
  const [status, setStatus] = React.useState('');
  const modelRequestSeq = React.useRef({});

  const setLoading = (role, value) => setRoleLoading((s) => ({ ...s, [role]: value }));

  const loadModels = React.useCallback(async (role, provider, refresh = false, background = false) => {
    if (!provider) {
      modelRequestSeq.current[role] = (modelRequestSeq.current[role] || 0) + 1;
      setRoleModels((m) => ({ ...m, [role]: [] }));
      setRoleModelMeta((m) => ({ ...m, [role]: undefined }));
      return;
    }
    const requestId = (modelRequestSeq.current[role] || 0) + 1;
    modelRequestSeq.current[role] = requestId;
    if (refresh) {
      setRoleModelMeta((m) => ({
        ...m,
        [role]: { ...(m[role] || {}), provider, syncing: true },
      }));
    }
    if (!background) setLoading(role, true);
    try {
      const res = await fetch(
        `/api/role-models?role=${encodeURIComponent(role)}&provider=${encodeURIComponent(provider)}${refresh ? '&refresh=1' : ''}`,
      );
      const payload = res.ok ? await res.json() : null;
      if (!res.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${res.status}`);
      if (modelRequestSeq.current[role] !== requestId) return;
      setRoleModels((m) => ({ ...m, [role]: Array.isArray(payload.models) ? payload.models : [] }));
      const meta = {
        provider,
        source: payload.source || 'empty',
        fetchedAt: typeof payload.fetchedAt === 'number' ? payload.fetchedAt : null,
        stale: !!payload.stale,
        refreshFailed: refresh && payload.source === 'cache',
        syncing: false,
      };
      setRoleModelMeta((m) => ({ ...m, [role]: meta }));
      if (refresh) {
        setStatus(
          meta.refreshFailed
            ? `${role}: live catalogue refresh failed; showing the last cached list`
            : `${role}: live ${provider} catalogue synced`,
        );
      }
    } catch (err) {
      if (modelRequestSeq.current[role] !== requestId) return;
      setStatus(`${role}: ${err && err.message ? err.message : String(err)}`);
      setRoleModels((m) => ({ ...m, [role]: [] }));
      setRoleModelMeta((m) => ({
        ...m,
        [role]: { provider, source: 'empty', fetchedAt: null, stale: false, refreshFailed: refresh, syncing: false },
      }));
    } finally {
      if (!background && modelRequestSeq.current[role] === requestId) setLoading(role, false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStatus('');
    fetch('/api/providers')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const ovr = payload.overrides || {};
        setProviders(payload.providers || []);
        setRoles(payload.roles || []);
        setOverrides(ovr);
        const rp = {};
        for (const role of payload.roles || []) rp[role] = ovr[role] ? ovr[role].provider : '';
        setRoleProvider(rp);
        // Populate model lists for roles that already have an override.
        for (const role of payload.roles || []) {
          if (ovr[role]) loadModels(role, ovr[role].provider, true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(`Could not load providers: ${err && err.message ? err.message : String(err)}`);
      });
    return () => { cancelled = true; };
  }, [open, loadModels]);

  const saveOverride = async (role, provider, model) => {
    setLoading(role, true);
    setStatus(provider && model ? 'saving...' : 'reverting...');
    try {
      const res = await fetch('/api/role-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, provider, model }),
      });
      const payload = res.ok ? await res.json() : null;
      if (!res.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${res.status}`);
      setOverrides((o) => ({ ...o, [role]: payload.selected || undefined }));
      setStatus(
        provider && model
          ? `${role} → ${provider}:${model} — applies to the next ${role} call`
          : `${role} reverted to its default chain`,
      );
    } catch (err) {
      setStatus(`${role}: save failed — ${err && err.message ? err.message : String(err)}`);
    } finally {
      setLoading(role, false);
    }
  };

  const onProviderChange = (role, provider) => {
    setRoleProvider((p) => ({ ...p, [role]: provider }));
    if (!provider) {
      saveOverride(role, null, null); // clear → default chain
      setRoleModels((m) => ({ ...m, [role]: [] }));
    } else {
      loadModels(role, provider, true);
    }
  };

  return (
    <div className="mm-settings-row">
      <span className="mm-settings-name">Model routing</span>
      <span className="mm-settings-hint">
        <strong>API provider</strong> is where the request is sent; <strong>model</strong> is the model
        selected inside that provider's catalogue. Leave a role on <em>Default</em> to use its built-in
        fallback chain. Live model lists per provider (CLI: <code>models set</code>).
      </span>
      <div className="mm-role-routing">
        {roles.map((role) => {
          const provider = roleProvider[role] || '';
          const models = roleModels[role] || [];
          const modelMeta = roleModelMeta[role] && roleModelMeta[role].provider === provider
            ? roleModelMeta[role]
            : null;
          const selected = overrides[role];
          const busy = !!roleLoading[role];
          const providerInfo = providers.find((p) => p.id === provider);
          const providerConfigured = !!providerInfo?.configured;
          const selectedForProvider = selected && selected.provider === provider ? selected : null;
          const selectedModel = selectedForProvider
            ? models.find((m) => m.id === selectedForProvider.model)
            : null;
          const selectedModelInList = !!selectedModel;
          const selectedMissingFromLive = !!selectedForProvider
            && modelMeta?.source === 'live'
            && !busy
            && !selectedModelInList;
          const providerLabel = providerInfo?.label || provider;
          const routeModelLabel = selectedModel
            ? modelLabel(selectedModel)
            : selectedForProvider?.model || '';
          const syncedAt = modelMeta?.fetchedAt
            ? new Date(modelMeta.fetchedAt).toLocaleString()
            : null;
          const catalogueMessage = modelMeta?.syncing
            ? 'Syncing live catalogue...'
            : !modelMeta
              ? 'Catalogue not loaded.'
              : modelMeta.source === 'live'
                ? `Live catalogue · synced ${syncedAt || 'just now'}.`
                : modelMeta.source === 'cache'
                  ? `${modelMeta.stale ? 'Stale cached' : 'Cached'} catalogue${syncedAt ? ` · synced ${syncedAt}` : ''}.${modelMeta.refreshFailed ? ' Live refresh failed.' : ''}`
                  : 'No catalogue models returned.';
          const nvidiaCatalogueNote = provider === 'nvidia'
            ? ' NVIDIA catalogue entries are verified for endpoint access only when a request runs.'
            : '';
          const routeMessage = !provider
            ? 'Active: built-in fallback chain chooses the first available model.'
            : !providerConfigured
              ? `Inactive: ${providerLabel} API key is missing. The built-in fallback chain is serving this role.${routeModelLabel ? ` Saved model: ${routeModelLabel}.` : ''}`
              : !selectedForProvider
                ? `Not active yet: choose a model to route through the ${providerLabel} API.`
                : selectedMissingFromLive
                  ? `Inactive: ${routeModelLabel} is not in the latest live ${providerLabel} catalogue. Choose another model.`
                  : `Active route: ${providerLabel} API → ${routeModelLabel}.`;
          return (
            <div className="mm-role-routing-row" key={role}>
              <span className="mm-role-routing-label">{ROLE_ROUTING_LABELS[role] || role}</span>
              <div className="mm-role-routing-controls">
                <span className="mm-role-routing-caption">API provider</span>
                <select
                  className="mm-settings-select"
                  value={provider}
                  disabled={busy}
                  onChange={(e) => onProviderChange(role, e.target.value)}
                  aria-label={`${role} API provider`}
                >
                  <option value="">Default fallback chain</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.configured}>
                      {p.label}{p.configured ? '' : ' (API key missing)'}
                    </option>
                  ))}
                </select>
                {provider ? (
                  <>
                  <span className="mm-role-routing-caption">Model catalogue through {providerLabel || 'provider'}</span>
                  <select
                    className="mm-settings-select"
                    onPointerDown={() => loadModels(role, provider, true, true)}
                    value={selectedForProvider ? selectedForProvider.model : ''}
                    disabled={busy || models.length === 0 || !providerConfigured}
                    onChange={(e) => saveOverride(role, provider, e.target.value)}
                    aria-label={`${role} model through ${providerLabel}`}
                  >
                    <option value="" disabled>
                      {!providerConfigured
                        ? 'API key required'
                        : busy ? 'loading…' : models.length === 0 ? 'no models' : 'choose model…'}
                    </option>
                    {selectedForProvider && !selectedModelInList ? (
                      <option value={selectedForProvider.model}>
                        {selectedForProvider.model} ({modelMeta?.source === 'live' ? 'not in live catalogue' : 'saved'})
                      </option>
                    ) : null}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{modelLabel(m)}</option>
                    ))}
                  </select>
                  <span
                    className={'mm-role-routing-catalogue' + ((modelMeta?.stale || modelMeta?.refreshFailed) ? ' warn' : '')}
                  >
                    {catalogueMessage}{nvidiaCatalogueNote}
                  </span>
                  </>
                ) : null}
                <span
                  className={'mm-role-routing-route' + ((provider && !providerConfigured) || selectedMissingFromLive ? ' warn' : '')}
                  role="status"
                >
                  {routeMessage}
                </span>
                {provider ? (
                  <button
                    type="button"
                    className="mm-settings-reset"
                    onClick={() => loadModels(role, provider, true)}
                    disabled={busy || !!modelMeta?.syncing}
                  >
                    sync live
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {status ? <span className="mm-settings-hint">{status}</span> : null}
    </div>
  );
}

function SettingsDrawer({ open, onClose, settings, onChange }) {
  const drawerRef = React.useRef(null);
  const scrimRef = React.useRef(null);
  // Hybrid-mode health gate. When the user toggles 'Hybrid local models'
  // ON we ping /api/ollama-health; if the daemon isn't reachable OR the
  // two required models aren't pulled, we refuse the toggle and surface
  // a clear reason. This prevents the silent-fail state where chat turns
  // pretend to work in hybrid mode but every local hop falls through to
  // the cloud fallback, which is confusing.
  const [hybridError, setHybridError] = React.useState(null);
  const [hybridChecking, setHybridChecking] = React.useState(false);
  const [roleInstructions, setRoleInstructions] = React.useState(null);
  const [roleInstructionDefaults, setRoleInstructionDefaults] = React.useState(null);
  const [roleInstructionsPath, setRoleInstructionsPath] = React.useState('');
  const [roleInstructionsStatus, setRoleInstructionsStatus] = React.useState('');
  const [roleInstructionsSaving, setRoleInstructionsSaving] = React.useState(false);
  // Close on Escape so the drawer doesn't trap focus.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  React.useEffect(() => {
    if (drawerRef.current) drawerRef.current.inert = !open;
    if (scrimRef.current) scrimRef.current.inert = !open;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRoleInstructionsStatus('');
    fetch('/api/role-instructions')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (cancelled) return;
        setRoleInstructions(normalizeRoleInstructionPayload(payload.instructions));
        setRoleInstructionDefaults(normalizeRoleInstructionPayload(payload.defaults || payload.instructions));
        setRoleInstructionsPath(payload.path || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setRoleInstructionsStatus(`Could not load role instructions: ${err && err.message ? err.message : String(err)}`);
        setRoleInstructions(normalizeRoleInstructionPayload(null));
        setRoleInstructionDefaults(null);
      });
    return () => { cancelled = true; };
  }, [open]);

  const onToggleLocal = async (e) => {
    const wantsOn = e.target.checked;
    if (!wantsOn) {
      setHybridError(null);
      onChange({ ...settings, useLocal: false });
      return;
    }
    setHybridChecking(true);
    setHybridError(null);
    try {
      const res = await fetch('/api/ollama-health');
      const health = res.ok ? await res.json() : { reachable: false, reason: `HTTP ${res.status}` };
      if (!health.reachable) {
        setHybridError(`Local Ollama daemon not detected at ${health.baseUrl || 'localhost:11434'}${health.reason ? ' — ' + health.reason : ''}. Install Ollama and pull the required models, or leave hybrid mode off.`);
        onChange({ ...settings, useLocal: false });
      } else if (health.missing && health.missing.length > 0) {
        setHybridError(`Ollama is running, but these required models are missing: ${health.missing.join(', ')}. Run \`ollama pull <model>\` for each, then try again.`);
        onChange({ ...settings, useLocal: false });
      } else {
        onChange({ ...settings, useLocal: true });
      }
    } catch (err) {
      setHybridError(`Could not reach /api/ollama-health: ${err && err.message ? err.message : String(err)}`);
      onChange({ ...settings, useLocal: false });
    } finally {
      setHybridChecking(false);
    }
  };

  const routingValue = routingValueFromSettings(settings);
  const onRoutingChange = (e) => {
    const opt = ROUTING_OPTIONS.find((o) => o.value === e.target.value);
    if (!opt) return;
    onChange({ ...settings, forceRole: opt.forceRole, routingMode: opt.routingMode });
  };

  const updateRoleInstructions = (next) => {
    setRoleInstructions(normalizeRoleInstructionPayload(next));
    setRoleInstructionsStatus('edited locally - save to apply to new turns');
  };

  const persistRoleInstructions = async (input, successMessage) => {
    const instructions = normalizeRoleInstructionPayload(input);
    setRoleInstructionsSaving(true);
    setRoleInstructionsStatus('saving...');
    try {
      const res = await fetch('/api/role-instructions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions }),
      });
      const payload = res.ok ? await res.json() : null;
      if (!res.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${res.status}`);
      setRoleInstructions(normalizeRoleInstructionPayload(payload.instructions));
      if (payload.defaults) setRoleInstructionDefaults(normalizeRoleInstructionPayload(payload.defaults));
      setRoleInstructionsPath(payload.path || roleInstructionsPath);
      setRoleInstructionsStatus(successMessage);
    } catch (err) {
      setRoleInstructionsStatus(`Save failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      setRoleInstructionsSaving(false);
    }
  };

  const saveRoleInstructions = () => persistRoleInstructions(
    roleInstructions,
    'saved - the next chat turn will use these instructions',
  );

  const restoreRoleInstructionDefaults = () => {
    if (!roleInstructionDefaults) return;
    return persistRoleInstructions(
      roleInstructionDefaults,
      'recommended quality defaults restored - the next chat turn will use them',
    );
  };

  const usingRecommendedRoleDefaults = !!(
    roleInstructions
    && roleInstructionDefaults
    && roleInstructionPayloadsEqual(roleInstructions, roleInstructionDefaults)
  );

  return (
    <>
      <div
        ref={scrimRef}
        className={'mm-settings-scrim' + (open ? ' open' : '')}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        ref={drawerRef}
        className={'mm-settings-drawer' + (open ? ' open' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        aria-hidden={!open}
      >
        <div className="mm-settings-head">
          <span className="mm-settings-title">Settings</span>
          <button className="mm-settings-close" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <div className="mm-settings-body">
          <div className="mm-settings-row">
            <span className="mm-settings-name">Appearance</span>
            <div className="mm-theme-segment" role="group" aria-label="Theme">
              {[
                ['clay', 'clay'],
                ['paper', 'paper'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={settings.theme === value ? 'active' : ''}
                  onClick={() => onChange({ ...settings, theme: value })}
                  aria-pressed={settings.theme === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="mm-settings-hint">paper switches the workspace to warm ink-on-paper colours while keeping the same layout.</span>
          </div>

          <div className="mm-settings-row">
            <label className="mm-settings-label">
              <input
                type="checkbox"
                checked={settings.useLocal}
                disabled={hybridChecking}
                onChange={onToggleLocal}
              />
              <span className="mm-settings-text">
                <span className="mm-settings-name">
                  Hybrid local models
                  {hybridChecking ? <span className="mm-settings-hint" style={{ marginLeft: 8 }}>checking…</span> : null}
                </span>
                <span className="mm-settings-hint">route reasoning → Qwen 3.5 9B and action-code → Qwen 2.5 Coder 14B on your local Ollama daemon. Other roles unchanged. (CLI: <code>--local</code>)</span>
                {hybridError ? (
                  <span className="mm-settings-error" role="alert">{hybridError}</span>
                ) : null}
              </span>
            </label>
          </div>
          <ModelRoutingSection open={open} />
          <div className="mm-settings-row">
            <label className="mm-settings-label">
              <input
                type="checkbox"
                checked={settings.builder}
                onChange={(e) => onChange({ ...settings, builder: e.target.checked })}
              />
              <span className="mm-settings-text">
                <span className="mm-settings-name">Builder mode</span>
                <span className="mm-settings-hint">slower multi-file workflow: the model may inspect project files and stage files for review, but cannot write to the project.</span>
              </span>
            </label>
          </div>
          <div className="mm-settings-row">
            <label className="mm-settings-label">
              <input
                type="checkbox"
                checked={settings.serious}
                onChange={(e) => onChange({ ...settings, serious: e.target.checked })}
              />
              <span className="mm-settings-text">
                <span className="mm-settings-name">Serious mode</span>
                <span className="mm-settings-hint">adds <code>thinking: high</code> to every Gemini call — slower, more deliberate (CLI: <code>--serious</code>)</span>
              </span>
            </label>
          </div>
          <div className="mm-settings-row">
            <label className="mm-settings-label">
              <input
                type="checkbox"
                checked={settings.search}
                onChange={(e) => onChange({ ...settings, search: e.target.checked })}
              />
              <span className="mm-settings-text">
                <span className="mm-settings-name">Google Search grounding</span>
                <span className="mm-settings-hint">Gemini uses native grounding; perception fallbacks get Brave/DuckDuckGo context (CLI: <code>--search</code>)</span>
              </span>
            </label>
          </div>
          <div className="mm-settings-row mm-settings-row-select">
            <span className="mm-settings-name">Routing</span>
            <select
              className="mm-settings-select"
              value={routingValue}
              onChange={onRoutingChange}
            >
              {ROUTING_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <span className="mm-settings-hint">
              <code>auto</code>: orchestrator picks the shortest useful route. <code>multi-agent</code>: plan, research/action, check/repair when needed, then format (default). <code>brainstorming</code>: multiple model perspectives in parallel. Pick a specific role to pin every turn to that role's chain (CLI: <code>--role=&lt;name&gt;</code>).
            </span>
          </div>
          <div className="mm-settings-row mm-settings-row-instructions">
            <span className="mm-settings-name">Long-term role instructions</span>
            <span className="mm-settings-hint">
              Web-only local memory. Saved to <code>{roleInstructionsPath || '~/.multi-agent/role-instructions.json'}</code>; you can edit the file directly too. Global text goes to every role, and each role box only goes to that specialist. The built-in recommended preset can always be restored.
            </span>
            {roleInstructions ? (
              <div className="mm-role-instructions-editor">
                <label className="mm-role-instruction-field">
                  <span>Global</span>
                  <textarea
                    value={roleInstructions.global}
                    onChange={(e) => updateRoleInstructions({
                      ...roleInstructions,
                      global: e.target.value,
                    })}
                    placeholder="Example: Use concise Australian English. Preserve technical detail."
                  />
                </label>
                {ROLE_INSTRUCTION_ROLES.map((role) => (
                  <label className="mm-role-instruction-field" key={role}>
                    <span>{role}</span>
                    <textarea
                      value={(roleInstructions.roles && roleInstructions.roles[role]) || ''}
                      onChange={(e) => updateRoleInstructions({
                        ...roleInstructions,
                        roles: {
                          ...roleInstructions.roles,
                          [role]: e.target.value,
                        },
                      })}
                      placeholder={`Instructions only for ${role}`}
                    />
                  </label>
                ))}
                <div className="mm-role-instructions-actions">
                  <button
                    className="mm-settings-reset"
                    onClick={saveRoleInstructions}
                    disabled={roleInstructionsSaving}
                  >
                    {roleInstructionsSaving ? 'saving...' : 'save role instructions'}
                  </button>
                  <button
                    className="mm-settings-reset"
                    onClick={restoreRoleInstructionDefaults}
                    disabled={roleInstructionsSaving || !roleInstructionDefaults || usingRecommendedRoleDefaults}
                    title="Replace all global and role-specific text with the built-in recommended quality preset"
                  >
                    {usingRecommendedRoleDefaults ? 'recommended defaults active' : 'restore recommended defaults'}
                  </button>
                  {roleInstructionsStatus ? (
                    <span className="mm-settings-hint">{roleInstructionsStatus}</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <span className="mm-settings-hint">loading role instructions...</span>
            )}
          </div>
          <div className="mm-settings-foot">
            <button
              className="mm-settings-reset"
              onClick={() => onChange({ ...DEFAULT_SETTINGS })}
              title="Reset all settings to defaults"
            >
              reset to defaults
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function settingsActiveCount(s) {
  let n = 0;
  if (s.serious) n++;
  if (s.builder) n++;
  if (s.search) n++;
  if (s.useLocal) n++;
  if (s.theme && s.theme !== 'clay') n++;
  // Routing is now a single merged knob (routingMode + forceRole). The
  // default is the round-robin meta-entry, so any other dropdown value
  // counts as a non-default knob.
  if (routingValueFromSettings(s) !== 'multi-agent') n++;
  return n;
}

/** Remove numeric key-slot suffixes (gemini:1 → gemini, gemma:2 → gemma).
 *  Non-numeric suffixes like groq:llama-70b are left unchanged. */
function stripSlot(id) {
  return id ? id.replace(/:(\d+)$/, '') : id;
}

function roleChromeLabel(role) {
  if (!role) return 'working';
  return String(role).replace(/^action-/, '').replace(/-/g, ' ');
}

/** Short human-readable label for the current Composer routing mode. */
function composerModeLabel(settings) {
  if (!settings) return 'smart routing';
  const rv = routingValueFromSettings(settings);
  const opt = ROUTING_OPTIONS.find(o => o.value === rv);
  // Strip "(default)" and parenthetical model hints from the stored label.
  let label = opt ? opt.label.replace(/\s*\([^)]*\)/g, '') : rv;
  const tags = [];
  if (settings.serious) tags.push('serious');
  if (settings.builder) tags.push('builder');
  if (settings.useLocal) tags.push('local');
  if (tags.length) label += ' · ' + tags.join(' · ');
  return label;
}

function Sidebar({ phase, latestResponse, open, useLocal }) {
  const { usage, usageFetchedAt } = useUsage(phase === 'response' ? 'response-tick' : undefined, useLocal);

  // 1 Hz tick so the cooldown countdown advances smoothly between polls.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const contextUsed = latestResponse?.tokenEstimate || 0;
  const contextBudget = latestResponse?.tokenBudget || 100000;
  const contextPct = latestResponse?.budgetPct ?? Math.min(100, (contextUsed / contextBudget) * 100);

  const quotaUsed = React.useMemo(() => {
    const map = Object.fromEntries(MM_AGENTS.map((a) => [a.id, 0]));
    const roles = usage.roles || {};
    for (const a of MM_AGENTS) {
      const r = roles[a.id];
      if (r && typeof r.remainingPct === 'number') {
        map[a.id] = Math.max(0, 100 - r.remainingPct);
      }
    }
    return map;
  }, [usage]);

  const [disp, setDisp] = React.useState(quotaUsed);
  React.useEffect(() => {
    const start = { ...disp };
    const t0 = performance.now();
    let raf;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 700);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = {};
      for (const k of Object.keys(quotaUsed)) {
        next[k] = Math.round(start[k] + (quotaUsed[k] - start[k]) * eased);
      }
      setDisp(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotaUsed]);

  return (
    <aside className={'mm-sidebar' + (open ? ' open' : '')}>
      <div className="mm-section">
        <div className="mm-lbl">agents <i>{phase === 'loading' ? 'routing' : 'live status'}</i></div>
        {MM_AGENTS.map((a) => {
          const role = (usage.roles || {})[a.id] || {};
          const isActive = phase === 'loading';
          const status = role.status === 'temporarily-unavailable'
            ? 'temp unavailable'
            : role.status === 'unavailable' || role.registered === false
              ? 'unavailable'
              : role.fallback
                ? 'fallback ready'
                : 'ready';
          return (
            <div
              key={a.id}
              className={
                'mm-agent-row' +
                (isActive ? ' active' : '') +
                (status.includes('unavailable') ? ' unavailable' : '') +
                ' status-' + status.replace(/\s+/g, '-')
              }
              style={{ '--c': a.color }}
              title={role.providerId ? `${role.providerId}${role.model ? ' · ' + role.model : ''}${role.fallback ? ' (fallback)' : ''}` : 'No provider registered'}
            >
              <span className="dot" />
              <span className="name">{a.name.toLowerCase()}<span className="ext">.agent</span></span>
              <span className="stat-live">{isActive ? 'routing...' : status}</span>
              <span className="stat">{isActive ? 'thinking…' : '✓ ready'}</span>
            </div>
          );
        })}
      </div>

      <div className="mm-section">
        <div className="mm-lbl">context <i>{contextPct.toFixed(0)}% used</i></div>
        <div className="mm-gauge">
          <div className="mm-gauge-head">
            <div>
              <span className="mm-gauge-num">{CompactNumber(contextUsed)}</span>
              <span className="mm-gauge-of">/ {CompactNumber(contextBudget)} context</span>
            </div>
            <span className="mm-gauge-pct">{contextPct.toFixed(1)}%</span>
          </div>
          <div className="mm-gauge-bar">
            <div className="mm-gauge-fill" style={{ width: Math.min(100, contextPct) + '%' }} />
          </div>
        </div>
        <div className="mm-lbl mm-lbl-sub">rate budgets <i>RPM · RPD</i></div>
        {MM_AGENTS.map((a) => {
          const role = (usage.roles || {})[a.id];
          // Compute live cooldown by subtracting elapsed-since-fetch from
          // the server-reported cooldownMsRemaining. Floors at 0 once expired.
          const elapsed = performance.now() - usageFetchedAt;
          const liveCooldownMs = role && role.cooling
            ? Math.max(0, (role.cooldownMsRemaining || 0) - elapsed)
            : 0;
          const isCooling = liveCooldownMs > 0;

          const localRow = isLocalProvider(role?.providerId);
          // Local providers (Ollama) have no remote rate cap — show ∞.
          // The cloud-style RPM/RPD gauges stay 0% filled so the user
          // sees at a glance that this row is on local infrastructure.
          const hasRpm = !localRow && role && typeof role.rpmCount === 'number' && role.rpmCap > 0;
          const hasRpd = !localRow && role && typeof role.remainingPct === 'number';
          const rpmCount = role?.rpmCount ?? 0;
          const rpmCap = role?.rpmCap ?? null;
          const rpmPct = hasRpm ? Math.min(100, (rpmCount / rpmCap) * 100) : 0;
          const rpdUsedPct = hasRpd ? Math.max(0, 100 - role.remainingPct) : 0;
          const successCount = role?.successCount ?? 0;
          const dailyBudget = role?.estimatedDailyBudget ?? null;

          return (
            <div
              key={a.id}
              className={
                'mm-rate-row' +
                (!hasRpm && !hasRpd && !localRow ? ' unknown' : '') +
                (isCooling ? ' cooling' : '') +
                (localRow ? ' local' : '')
              }
              style={{ '--c': a.color }}
              title={role?.providerId
                ? `${role.providerId}${role.model ? ' · ' + role.model : ''}${role.fallback ? ' (fallback)' : ''}${localRow ? ' — local Ollama daemon' : ''}`
                : 'No provider registered'}
            >
              <div className="mm-rate-head">
                <span className="mm-rate-label">{a.name.toLowerCase()}</span>
                {isCooling
                  ? <span className="mm-rate-cooling">cooling {formatCountdown(liveCooldownMs)}</span>
                  : <span className="mm-rate-provider">{role?.model || role?.providerId || 'n/a'}{role?.fallback && !localRow ? ' ⤳' : ''}</span>}
              </div>
              <div className="mm-rate-gauges">
                <div
                  className={'mm-rate-gauge mm-rate-source-' + (localRow ? 'local' : (role?.rpmSource || 'estimated'))}
                  title={localRow
                    ? 'Local model — no remote rate cap'
                    : (hasRpm
                      ? `${rpmCount} requests in last 60s (cap ${rpmCap}) — ${role?.rpmSource === 'live' ? 'reported by provider header' : 'estimated from local sliding window'}`
                      : 'No RPM cap')}
                >
                  <span className="mm-rate-gauge-label">RPM</span>
                  <span className="mm-rate-gauge-bar">
                    <span className="mm-rate-gauge-fill" style={{ width: rpmPct + '%' }} />
                  </span>
                  <span className="mm-rate-gauge-num tnum">
                    {localRow ? <span className="mm-rate-inf">∞</span> : (hasRpm ? `${rpmCount}/${rpmCap}` : '–')}
                    {!localRow && role?.rpmSource && <em className="mm-rate-src">{role.rpmSource === 'live' ? 'live' : 'est'}</em>}
                    {localRow && <em className="mm-rate-src">local</em>}
                  </span>
                </div>
                <div
                  className={'mm-rate-gauge mm-rate-source-' + (localRow ? 'local' : (role?.rpdSource || 'estimated'))}
                  title={localRow
                    ? 'Local model — no daily cap'
                    : (hasRpd
                      ? `${role?.rpdSource === 'live'
                          ? `${Math.round((100 - role.remainingPct) / 100 * dailyBudget)} of ${dailyBudget} daily quota used — reported by provider header`
                          : `${successCount} of ${dailyBudget} successes today (estimated; resets at UTC midnight)`}`
                      : 'No daily budget')}
                >
                  <span className="mm-rate-gauge-label">RPD</span>
                  <span className="mm-rate-gauge-bar">
                    <span className="mm-rate-gauge-fill" style={{ width: rpdUsedPct + '%' }} />
                  </span>
                  <span className="mm-rate-gauge-num tnum">
                    {localRow
                      ? <span className="mm-rate-inf">∞</span>
                      : (hasRpd
                          ? (role.rpdSource === 'live'
                              ? `${Math.round((100 - role.remainingPct) / 100 * dailyBudget)}/${dailyBudget}`
                              : `${successCount}/${dailyBudget}`)
                          : '–')}
                    {!localRow && role?.rpdSource && <em className="mm-rate-src">{role.rpdSource === 'live' ? 'live' : 'est'}</em>}
                    {localRow && <em className="mm-rate-src">local</em>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mm-section">
        <div className="mm-lbl">stream</div>
        <div className="mm-log">
          <div>session.turns={latestResponse?.turns || 0}</div>
          <div>router.mode={usage.mode || 'unknown'}</div>
          <div>served.by={(latestResponse?.servedBy || ['pending']).join('+')}</div>
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

// Hard caps for file-attach. Files larger than PER_FILE_MAX_BYTES are
// rejected; once TOTAL_MAX_BYTES is reached we stop accepting more.
// 256 KB / 1 MB are conservative — context budget is the real ceiling
// (chat budget defaults to 100k tokens ≈ 400 KB of English text).
const ATTACH_PER_FILE_MAX_BYTES = 256 * 1024;
const ATTACH_TOTAL_MAX_BYTES = 1024 * 1024;

// Detect a probably-binary file by scanning the first KB for NUL bytes.
// Good enough for the keep-it-text rule — UTF-8 text never contains \x00.
function looksBinary(text) {
  const sample = text.slice(0, 1024);
  return sample.indexOf('\x00') !== -1;
}

// Read a File as UTF-8 text. Rejects if larger than PER_FILE_MAX_BYTES
// or if the content looks binary. Returns { name, text } on success.
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    if (file.size > ATTACH_PER_FILE_MAX_BYTES) {
      reject(new Error(`${file.name} is ${(file.size / 1024).toFixed(0)} KB — over the ${ATTACH_PER_FILE_MAX_BYTES / 1024} KB per-file limit`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name}: read failed`));
    reader.onload = () => {
      const text = String(reader.result || '');
      if (looksBinary(text)) {
        reject(new Error(`${file.name} looks binary — only text files supported`));
        return;
      }
      resolve({ name: file.name, text });
    };
    reader.readAsText(file);
  });
}

function attachmentText(att) {
  return String(att?.text ?? att?.content ?? '');
}

// Render an attached file's content as a fenced block the model can read.
// Uses the file extension as the fence language hint when present.
function fenceForAttachment(att) {
  const text = attachmentText(att);
  const dot = att.name.lastIndexOf('.');
  const ext = dot > 0 ? att.name.slice(dot + 1).toLowerCase() : '';
  // Pick three backticks but bump count if the file itself contains them.
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}${ext}\n${text}\n${fence}`;
}

// Compose the final message body: attachments first, prompt last. The
// model sees "Attached files:" with each file's content fenced, then a
// blank line, then the user's actual prompt.
function composeMessageWithAttachments(prompt, attachments) {
  if (!attachments || attachments.length === 0) return prompt;
  const header = attachments.length === 1
    ? `Attached file: ${attachments[0].name}`
    : `Attached files (${attachments.length}): ${attachments.map((a) => a.name).join(', ')}`;
  const blocks = attachments.map((a) => `### ${a.name}\n${fenceForAttachment(a)}`).join('\n\n');
  return `${header}\n\n${blocks}\n\n---\n\n${prompt}`;
}

// ─── Image attachments (pasted / dropped / picked screenshots) ─────────────
const IMG_MAX_COUNT = 4;
const IMG_MAX_EDGE = 1568;          // longest edge (px) after downscale
const IMG_JPEG_QUALITY = 0.85;
const IMG_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Read an image File, downscale so its longest edge ≤ IMG_MAX_EDGE, and
// re-encode as JPEG to keep the base64 payload small. Returns
// { mimeType, dataBase64, previewUrl } — previewUrl is a data URL for the
// composer thumbnail. GIFs pass through unscaled to preserve animation
// (still bounded by the server's per-image byte cap).
function readImageDownscaled(file) {
  return new Promise((resolve, reject) => {
    if (!IMG_ALLOWED_MIME.includes(file.type)) {
      reject(new Error(`${file.name || 'image'}: unsupported type ${file.type || '?'}`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('image read failed'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (file.type === 'image/gif') {
        resolve({ mimeType: 'image/gif', dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), previewUrl: dataUrl });
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error('image decode failed'));
      img.onload = () => {
        const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL('image/jpeg', IMG_JPEG_QUALITY);
        resolve({ mimeType: 'image/jpeg', dataBase64: out.slice(out.indexOf(',') + 1), previewUrl: out });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

// Thumbnails (this session) or a count chip (after reload) for a turn's
// pasted images, shown next to the user's prompt in the transcript.
function ImageTurnIndicator({ entry }) {
  if (!entry) return null;
  const imgs = entry.images || [];
  const count = entry.imageCount || imgs.length;
  if (!count) return null;
  if (imgs.length) {
    return (
      <span className="mm-turn-thumbs">
        {imgs.map((im, i) => (
          <img key={i} src={im.previewUrl || `data:${im.mimeType};base64,${im.dataBase64}`} alt={`image ${i + 1}`} />
        ))}
      </span>
    );
  }
  return <span className="mm-turn-imgcount" title={`${count} image${count > 1 ? 's' : ''} sent`}>🖼 {count}</span>;
}

// ─── Composer (used in idle + response phases) ─────────────
function Composer({ value, onChange, onSubmit, autoFocus, disabled, attachments, setAttachments, settings, placeholder }) {
  const ref = React.useRef(null);
  const fileRef = React.useRef(null);
  const [attachError, setAttachError] = React.useState(null);
  const canAttach = typeof setAttachments === 'function';
  // Pasted/dropped/picked images live locally in the Composer and ride the
  // turn via onSubmit(images) — no prop-threading through the view layers.
  const [images, setImages] = React.useState([]);
  const [imgError, setImgError] = React.useState(null);
  const [dragOver, setDragOver] = React.useState(false);

  const addImageFiles = async (fileList) => {
    const incoming = Array.from(fileList || []).filter((f) => IMG_ALLOWED_MIME.includes(f.type));
    if (!incoming.length) return;
    setImgError(null);
    const accepted = [...images];
    const errors = [];
    for (const f of incoming) {
      if (accepted.length >= IMG_MAX_COUNT) { errors.push(`max ${IMG_MAX_COUNT} images`); break; }
      try { accepted.push(await readImageDownscaled(f)); }
      catch (err) { errors.push(err.message || String(err)); }
    }
    setImages(accepted);
    if (errors.length) setImgError(errors.join('; '));
  };

  const onPasteImages = (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  };

  const onDropImages = (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    setDragOver(false);
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  };

  const removeImage = (idx) => setImages((cur) => cur.filter((_, i) => i !== idx));

  // Single submit entry-point: hand images to the parent, then clear them.
  const doSubmit = () => {
    const imgs = images.map((im) => ({ mimeType: im.mimeType, dataBase64: im.dataBase64 }));
    onSubmit(imgs);
    setImages([]);
    setImgError(null);
  };
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

  const onPickFiles = async (e) => {
    setAttachError(null);
    const picked = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-picking the same filename later
    if (!picked.length || !canAttach) return;
    // Route image files to the image path; text files to the existing logic.
    const imageFiles = picked.filter((f) => (f.type || '').startsWith('image/'));
    if (imageFiles.length) addImageFiles(imageFiles);
    const files = picked.filter((f) => !(f.type || '').startsWith('image/'));
    if (!files.length) return;
    const current = attachments || [];
    const accepted = [...current];
    let total = accepted.reduce((acc, a) => acc + attachmentText(a).length, 0);
    const errors = [];
    for (const f of files) {
      if (total + f.size > ATTACH_TOTAL_MAX_BYTES) {
        errors.push(`${f.name}: would exceed total ${ATTACH_TOTAL_MAX_BYTES / 1024} KB cap`);
        continue;
      }
      try {
        const att = await readFileAsText(f);
        accepted.push(att);
        total += attachmentText(att).length;
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }
    setAttachments(accepted);
    if (errors.length) setAttachError(errors.join('; '));
  };

  const removeAttachment = (idx) => {
    if (!canAttach) return;
    const next = (attachments || []).filter((_, i) => i !== idx);
    setAttachments(next);
    if (next.length === 0) setAttachError(null);
  };

  const hasContent = !!value.trim() || (attachments && attachments.length > 0) || images.length > 0;
  return (
    <div
      className={'mm-composer' + (dragOver ? ' drag-over' : '')}
      onDragOver={(e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDropImages}
    >
      <div className="mm-composer-in">
        <div className="mm-composer-prefix">
          <span>$ lattice ~/ orchestrate</span>
          <span className="live">{disabled ? 'routing' : 'live'}</span>
        </div>
        {images.length > 0 && (
          <div className="mm-img-chips">
            {images.map((im, i) => (
              <span key={i} className="mm-img-chip" title={`image ${i + 1}`}>
                <img src={im.previewUrl} alt={`pasted image ${i + 1}`} />
                <button className="mm-img-x" onClick={() => removeImage(i)} aria-label={`Remove image ${i + 1}`} type="button">×</button>
              </span>
            ))}
          </div>
        )}
        {imgError && <div className="mm-attach-error" role="alert">{imgError}</div>}
        {canAttach && attachments && attachments.length > 0 && (
          <div className="mm-attach-chips">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="mm-attach-chip" title={`${a.name} · ${(attachmentText(a).length / 1024).toFixed(1)} KB`}>
                <span className="mm-attach-name">{a.name}</span>
                <span className="mm-attach-size">{(attachmentText(a).length / 1024).toFixed(1)} KB</span>
                <button className="mm-attach-x" onClick={() => removeAttachment(i)} aria-label={`Remove ${a.name}`}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachError && <div className="mm-attach-error" role="alert">{attachError}</div>}
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPasteImages}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); }
          }}
          placeholder={placeholder || "› describe what you need — research, code, comparison, plan…"}
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <div className="mm-composer-bar">
          <span className="mm-model"><i />{composerModeLabel(settings)}</span>
          {canAttach && attachments && attachments.length > 0 && (
            <span className="mm-attach-budget">
              {(attachments.reduce((s, a) => s + attachmentText(a).length, 0) / 1024).toFixed(0)} / {ATTACH_TOTAL_MAX_BYTES / 1024} KB
            </span>
          )}
          <div className="mm-composer-actions">
            {canAttach && (
              <>
                <input
                  type="file"
                  ref={fileRef}
                  multiple
                  style={{ display: 'none' }}
                  onChange={onPickFiles}
                  accept=".txt,.md,.markdown,.json,.yaml,.yml,.csv,.tsv,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cc,.cpp,.h,.hpp,.sh,.bash,.zsh,.ps1,.toml,.ini,.cfg,.conf,.log,.sql,.gql,.graphql,.proto,text/*,application/json,image/png,image/jpeg,image/webp,image/gif"
                />
                <button
                  className="mm-attach-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={disabled}
                  title="Attach text files or images (you can also paste a screenshot)"
                  aria-label="Attach file or image"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                    <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L13.5 4.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            <button className="mm-send" onClick={doSubmit} disabled={disabled || !hasContent}>
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
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
/**
 * Scan a model response for fenced code blocks whose first line is a
 * path comment ( // src/foo.ts  |  # src/foo.py  |  -- src/foo.sql ).
 * Returns unique { path, content } pairs so the UI can offer "apply to file".
 */
function EmptyState({ children }) {
  return (
    <div className="mm-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle className="mm-empty-accent" cx="17" cy="7" r="2" />
        <path d="M8 12h8M12 8v8" />
      </svg>
      <span>{children}</span>
    </div>
  );
}

function detectFileEdits(text) {
  if (!text) return [];
  const results = [];
  const seen = new Set();
  const fenceRe = /```[^\n`]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const lines = m[1].split('\n');
    if (lines.length < 2) continue;
    const pathMatch = lines[0].match(/^(?:\/\/|#|--|\/\*)\s*([\w./\\-]+\.[a-zA-Z]{1,10})\s*$/);
    if (!pathMatch) continue;
    const path = pathMatch[1].replace(/^\//, '');
    if (seen.has(path) || path.startsWith('http')) continue;
    seen.add(path);
    results.push({ path, content: lines.slice(1).join('\n').replace(/\n$/, '') });
  }
  return results;
}

function soonestCooldownMs(usage) {
  const values = [];
  for (const role of Object.values(usage?.roles || {})) {
    for (const candidate of role?.candidates || []) {
      if (candidate?.cooldownMsRemaining > 0) values.push(candidate.cooldownMsRemaining);
    }
  }
  if (values.length === 0) {
    for (const provider of usage?.providers || []) {
      if (provider?.cooldownMsRemaining > 0) values.push(provider.cooldownMsRemaining);
    }
  }
  return values.length ? Math.min(...values) : null;
}

function ErrorTurnCard({ entry, isNewest, onRetry, retryDisabled }) {
  const quota = entry.error?.kind === 'quota';
  const imagesMissing = (entry.imageCount || 0) > 0 && (!entry.images || entry.images.length === 0);
  const disabled = retryDisabled || imagesMissing;
  const [cooldownMs, setCooldownMs] = React.useState(null);
  const [autoRetry, setAutoRetry] = React.useState(entry.autoRetryAllowed !== false);
  const [visibilityTick, setVisibilityTick] = React.useState(0);
  const autoFired = React.useRef(false);

  React.useEffect(() => {
    if (!quota || !isNewest) return undefined;
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/usage.json');
        if (!response.ok) return;
        const next = soonestCooldownMs(await response.json());
        if (live && next !== null) setCooldownMs(next);
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [quota, isNewest]);

  React.useEffect(() => {
    if (cooldownMs === null || cooldownMs <= 0) return undefined;
    const timer = setInterval(() => setCooldownMs((value) => value === null ? null : Math.max(0, value - 1000)), 1000);
    return () => clearInterval(timer);
  }, [cooldownMs === null]);

  React.useEffect(() => {
    const onVisibility = () => setVisibilityTick((value) => value + 1);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  React.useEffect(() => {
    if (!quota || !isNewest || cooldownMs !== 0 || !autoRetry || disabled || autoFired.current) return;
    if (document.visibilityState !== 'visible') return;
    autoFired.current = true;
    setAutoRetry(false);
    onRetry?.(true);
  }, [quota, isNewest, cooldownMs, autoRetry, disabled, onRetry, visibilityTick]);

  return (
    <section className="mm-turn-error-card" role="alert">
      <div className="mm-turn-error-icon" aria-hidden="true">!</div>
      <div className="mm-turn-error-body">
        <strong>{quota ? 'All free candidates for this route are cooling' : 'This turn failed — the reply was not generated'}</strong>
        {quota && isNewest && cooldownMs !== null && <span className="mm-turn-error-countdown">retries in ~{formatCountdown(cooldownMs)}</span>}
        <details><summary>Technical details</summary><pre>{entry.error?.message || 'Unknown provider error'}</pre></details>
        <div className="mm-turn-error-actions">
          <button type="button" onClick={() => onRetry?.(false)} disabled={disabled}>↻ retry</button>
          {quota && isNewest && entry.autoRetryAllowed !== false && (
            <label><input type="checkbox" checked={autoRetry} onChange={(event) => setAutoRetry(event.target.checked)} disabled={disabled} /> auto-retry once</label>
          )}
        </div>
        {imagesMissing && <span className="mm-turn-error-note">Retry is unavailable after reload because attached images are not stored.</span>}
      </div>
    </section>
  );
}

function BuilderChecklist({ activities, streaming }) {
  const [showAll, setShowAll] = React.useState(false);
  const inspected = activities.filter((item) => item.name === 'list_project' || item.name === 'read_project_file');
  const staged = activities.filter((item) => item.name === 'stage_file');
  const rows = [
    ...(inspected.length ? [{ name: `inspected ${inspected.length} file${inspected.length === 1 ? '' : 's'}`, ok: inspected.every((item) => item.ok !== false) }] : []),
    ...staged.map((item) => ({ name: item.path || 'staged file', ok: item.ok !== false })),
  ];
  const visible = showAll ? rows : rows.slice(-12);
  return (
    <section className="mm-builder-activity" aria-live="polite">
      <strong>builder · {staged.filter((item) => item.ok !== false).length} file(s) staged</strong>
      {visible.map((row, index) => <span key={index} className={row.ok ? '' : 'failed'}><b aria-hidden="true">{row.ok ? '✓' : '✕'}</b> {row.name}</span>)}
      {streaming && <span className="in-flight"><i aria-hidden="true" /> working…</span>}
      {!showAll && rows.length > 12 && <button type="button" onClick={() => setShowAll(true)}>show all ({rows.length})</button>}
    </section>
  );
}

// One turn in the chat-style scroll view. User prompt on top
// (right-aligned), AI response below (left-aligned). The AI bubble
// renders the orchestrator's RAW prose answer (no category split —
// that's the mindmap's job). Newest gets a subtle accent ring.
function ChatTurn({ entry, accent, isNewest, onApplyEdit, onReviewArtifact, onUndoArtifact, onOpenArtifactFiles, onRetry, retryDisabled }) {
  const tpl = TEMPLATE_DEFS[entry.template];
  const streaming = !!entry.streaming;
  const ArtifactCard = window.ArtifactTurnCard;
  // Status pill: while streaming, surface the live phase (plan / role /
  // synth) so the user reads what's happening. Once the turn lands, fall
  // back to servedBy or the template label.
  const liveLabel = streaming
    ? statusLabel(entry.status)
    : (entry.servedBy?.length
        ? entry.servedBy.map(stripSlot).join(' + ')
        : (tpl?.label || entry.template));
  return (
    <div
      className={'mm-turn' + (isNewest ? ' newest' : '') + (streaming ? ' streaming' : '')}
      style={{ '--accent': accent }}
    >
      <div className="mm-turn-user">
        <span className="mm-turn-role">you</span>
        <div className="mm-turn-user-bubble"><InlineMarkdown text={entry.prompt || ''} /></div>
      </div>
      <div className="mm-turn-ai">
        <span className="mm-turn-role">
          orchestrator
          <span className={'mm-turn-pill' + (streaming ? ' live' : '')}>
            <span className="mm-template-dot" />
            {liveLabel}
          </span>
        </span>
        <div className="mm-turn-ai-bubble" aria-busy={streaming}>
          {isNewest && (
            <span className="mm-sr-only" role="status" aria-live="polite">
              {streaming ? 'Generating reply...' : entry.error ? 'Turn failed' : 'Reply ready'}
            </span>
          )}
          {entry.text ? (
            <>{entry.error && !streaming && <span className="mm-turn-partial-label">Partial reply</span>}<MarkdownProse text={entry.text} /></>
          ) : !entry.error ? <span className="mm-turn-empty">{streaming ? 'preparing reply…' : ''}</span> : null}
          {streaming && <span className="mm-turn-caret" aria-hidden="true" />}
          {Array.isArray(entry.toolActivity) && entry.toolActivity.length > 0 && (
            <BuilderChecklist activities={entry.toolActivity} streaming={streaming} />
          )}
          {entry.error && !streaming && <ErrorTurnCard entry={entry} isNewest={isNewest} onRetry={onRetry} retryDisabled={retryDisabled} />}
          <div className="mm-turn-foot">
            <CopyButton getText={() => entry.text || ''} />
            {!streaming && onApplyEdit && detectFileEdits(entry.text).map(edit => (
              <button
                key={edit.path}
                className="mm-turn-apply-btn"
                onClick={() => onApplyEdit(edit.path, edit.content)}
                title={'Apply this code to ' + edit.path}
              >apply → {edit.path}</button>
            ))}
            {!streaming && (entry.elapsedMs > 0 || entry.tokenEstimate > 0) && (
              <span className="mm-turn-timing">
                {entry.elapsedMs > 0 && `took ${(entry.elapsedMs / 1000).toFixed(1)} s`}
                {entry.elapsedMs > 0 && entry.tokenEstimate > 0 && ' · '}
                {entry.tokenEstimate > 0 && `~${entry.tokenEstimate >= 1000 ? (entry.tokenEstimate / 1000).toFixed(1) + 'k' : entry.tokenEstimate} tok`}
              </span>
            )}
          </div>
          {!streaming && ArtifactCard && entry.artifact && (
            <ArtifactCard
              artifact={entry.artifact}
              receipt={entry.artifactReceipt}
              onReview={() => onReviewArtifact && onReviewArtifact(entry)}
              onUndo={() => onUndoArtifact && onUndoArtifact(entry)}
              onOpenFiles={onOpenArtifactFiles}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Translate a ChatProgressEvent shape into a short pill label.
function statusLabel(status) {
  if (!status) return 'routing…';
  // Prefer kind (the outer event type: 'role-start' / 'role-end' / 'plan' / ...)
  // over phase (the inner sub-phase: 'single' / 'synthesis' / 'direct' / ...).
  // The streaming handler does `{phase: evt.kind, ...evt}`, so the spread
  // overrides phase with evt.phase when present — we must read kind first
  // or every role-start gets misclassified as its inner phase and falls
  // through to the generic 'thinking…' default.
  const ph = status.kind || status.phase;
  if (ph === 'plan-start') return 'orchestrator planning…';
  if (ph === 'plan') return `plan: ${status.plan?.kind || '?'}`;
  if (ph === 'role-start') {
    if (status.phase === 'synthesis') return 'synthesizing...';
    if (status.phase === 'direct') return 'orchestrator answering...';
    if (status.phase === 'planning') return 'reasoning planning...';
    if (status.phase === 'research') return 'perception researching...';
    if (status.phase === 'action') return `${status.role || 'agent'}: acting...`;
    if (status.phase === 'check') return 'checking result...';
    if (status.phase === 'repair') return 'reasoning repair...';
    if (status.phase === 'format') return 'formatting response...';
    return `${status.role || 'agent'}: thinking...`;
  }
  if (ph === 'role-end') return `${status.role || 'agent'}: done`;
  if (ph === 'summarize-start') return 'summarizing older turns…';
  if (ph === 'summarize-end') return `summarized ${status.folded || 0} turn(s)`;
  return 'thinking…';
}

function InlineMarkdown({ text }) {
  const parts = [];
  // $$...$$ must appear before $...$ in the alternation so display math is matched first.
  // Math spans are passed through verbatim so MathJax can typeset them undamaged.
  const re = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('$')) {
      // Math span — output verbatim so MathJax receives clean LaTeX
      parts.push(token);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => typeof p === 'string' ? <React.Fragment key={i}>{p}</React.Fragment> : p)}</>;
}

function CodeBlock({ lang, text }) {
  const ref = React.useRef(null);
  const [wrap, setWrap] = React.useState(false);
  const label = lang && String(lang).trim() ? String(lang).trim() : 'text';
  React.useEffect(() => {
    const hl = window.hljs;
    if (!hl || !ref.current) return;
    // Clear any prior highlight so re-renders with new text work correctly.
    delete ref.current.dataset.highlighted;
    ref.current.textContent = text;
    try {
      if (lang && hl.getLanguage(lang)) {
        ref.current.className = 'language-' + lang;
        hl.highlightElement(ref.current);
      } else if (text.length <= 4096) {
        ref.current.className = '';
        hl.highlightElement(ref.current);
      }
    } catch {}
  }, [text, lang]);
  return (
    <div className="mm-code-block">
      <div className="mm-code-header">
        <span className="mm-code-lang">{label}</span>
        <div className="mm-code-actions">
          <button
            type="button"
            className={'mm-code-wrap-toggle' + (wrap ? ' active' : '')}
            onClick={() => setWrap((v) => !v)}
            aria-pressed={wrap}
            title={wrap ? 'Disable line wrap' : 'Wrap long lines'}
          >
            wrap
          </button>
          <CopyButton tiny getText={() => text} />
        </div>
      </div>
      <pre className={wrap ? 'wrap' : ''}><code ref={ref}>{text}</code></pre>
    </div>
  );
}

function MarkdownProse({ text }) {
  const rootRef = React.useRef(null);
  React.useEffect(() => {
    const mj = window.MathJax;
    if (mj?.typesetPromise && rootRef.current) {
      mj.typesetPromise([rootRef.current]).catch(() => {});
    }
  }, [text]);
  const blocks = parseMarkdownBlocks(text || '');
  return (
    <div className="mm-turn-prose" ref={rootRef}>
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = `h${Math.min(4, Math.max(2, b.level))}`;
          return <Tag key={i}><InlineMarkdown text={b.text} /></Tag>;
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return <Tag key={i}>{b.items.map((x, j) => <li key={j}><InlineMarkdown text={x} /></li>)}</Tag>;
        }
        if (b.type === 'code') return <CodeBlock key={i} lang={b.lang} text={b.text} />;
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
      const lang = (line.trim().match(/^```(\w+)/) || [])[1] || '';
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test((lines[i] || '').trim())) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, text: code.join('\n') });
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
        <ImageTurnIndicator entry={entry} />
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
function BarHandle({ onExpand, disabled, sliding, slideDistance, dataState, errorMessage }) {
  const [dragY, setDragY] = React.useState(0);
  const startY = React.useRef(0);
  const dragging = React.useRef(false);
  const fired = React.useRef(false);

  // dataState reflects the categorization pipeline:
  //   'ready'       — entry.data validated, burst is instant
  //   'structuring' — prefetch in flight; click still works but will await
  //   'failed'      — prefetch returned no valid shape; we let the click
  //                   through and the parent expand() surfaces a toast
  //                   instead of rendering fictional fallback data
  //   undefined     — no entry yet (shouldn't happen with current callers)
  const isStructuring = dataState === 'structuring';
  const isFailed = dataState === 'failed';

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
  const label = errorMessage
    ? errorMessage
    : isStructuring
      ? 'structuring…'
      : isFailed
        ? "couldn't structure — click anyway"
        : 'burst into mindmap';

  return (
    <button
      className={
        'mm-seam-handle' +
        (disabled ? ' disabled' : '') +
        (sliding ? ' sliding' : '') +
        (dragY > 0 ? ' active' : '') +
        (isStructuring ? ' structuring' : '') +
        (isFailed ? ' failed' : '')
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
      <span className="mm-seam-void" aria-hidden="true" />
      <span className="mm-seam-knob">
        <svg viewBox="0 0 18 14" fill="none" aria-hidden="true">
          <path d="M3 3 L9 7 L15 3 M3 8 L9 12 L15 8"
            stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="mm-seam-label">{label}</span>
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

// COLLAPSE_TIMELINE — v4 "center-split rip" catalyst.
//   anticipation: right arm slides in horizontally from off-canvas right,
//                 claw open, decelerating toward screen center.
//   puncture:     claws snap shut; both arms jab in; crack-flash + debris
//                 spawn. Left arm enters simultaneously from left.
//   pull:         both halves split to opposite edges revealing white canvas
//                 from center out. Real chat hidden via CSS at puncture start.
//   retreat:      both arms continue off-screen; claws open.
//   shatter:      particles spawn from center cluster on white canvas. (re-timed)
//   fountain:     particles arc to their final orbital positions. (re-timed)
const COLLAPSE_TIMELINE = {
  anticipation: { start:    0, dur: 520 },
  puncture:     { start:  520, dur: 200 },
  pull:         { start:  720, dur: 720 },
  retreat:      { start: 1440, dur: 300 },
  shatter:      { start: 1740, dur: 200 },
  fountain:     { start: 1940, dur: 460 },
  total: 2400,
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

  const easeInCubic  = (u) => u * u * u;
  const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);

  // ── Both arms — enter simultaneously during anticipation ──────────────
  // armX: px offset of arm SVG center from screen center, positive = rightward.
  // Knuckle face sits at SVG y≈77 which after rotate(90deg) is ~88px from SVG
  // center → armX_home=90 puts the knuckle face ≈ at screen center (x≈2px off).
  // Jab direction: right arm punches LEFT (armX decreases) so knuckles slam
  // through center; left arm punches RIGHT (armX increases, mirrored).
  let armX_r = 820, armY_r = 0, armRot_r = 0, clawOpen_r = 1;
  let armX_l = -820, armY_l = 0, armRot_l = 0, clawOpen_l = 1;
  if (t < COLLAPSE_TIMELINE.anticipation.start + COLLAPSE_TIMELINE.anticipation.dur) {
    const u = easeOutCubic(progress('anticipation'));
    armX_r =  820 - 730 * u;   // +820 → +90 (easeOut decel, open hand approaching)
    armX_l = -820 + 730 * u;   // -820 → -90 (symmetric from left)
    clawOpen_r = 1;
    clawOpen_l = 1;
  } else if (t < COLLAPSE_TIMELINE.puncture.start + COLLAPSE_TIMELINE.puncture.dur) {
    const u = progress('puncture');
    // Punch TOWARD center: knuckles slam past zero, grip closes on contact
    armX_r =  90 - Math.sin(u * Math.PI) * 25;  // +90 → +65 → +90 (jab 25px through)
    armX_l = -90 + Math.sin(u * Math.PI) * 25;  // -90 → -65 → -90 (mirrored)
    clawOpen_r = 1 - u;  // hand closes during jab
    clawOpen_l = 1 - u;
  } else if (t < COLLAPSE_TIMELINE.pull.start + COLLAPSE_TIMELINE.pull.dur) {
    const u = easeInCubic(progress('pull'));
    armX_r =  90 + u * 670;   // +90 → +760 (accelerates outward)
    armX_l = -90 - u * 670;   // -90 → -760
    armRot_r =  u * 6;
    armRot_l = -u * 6;
    clawOpen_r = 0;
    clawOpen_l = 0;
  } else if (t < COLLAPSE_TIMELINE.retreat.start + COLLAPSE_TIMELINE.retreat.dur) {
    const u = progress('retreat');
    armX_r =  760 + u * 640;  // → +1400 off-screen
    armX_l = -760 - u * 640;
    armRot_r =  6 * (1 - u);
    armRot_l = -6 * (1 - u);
    clawOpen_r = u;
    clawOpen_l = u;
  } else {
    armX_r =  1400; clawOpen_r = 1;
    armX_l = -1400; clawOpen_l = 1;
  }
  const armVis_r = t < COLLAPSE_TIMELINE.retreat.start + COLLAPSE_TIMELINE.retreat.dur + 80;
  const armVis_l = armVis_r;  // both arms visible from t=0

  // ── Torn dark half panels ──────────────────────────────────────
  // Appear at puncture; translateX tracks arm grip so grip looks attached.
  const halvesVisible = t >= COLLAPSE_TIMELINE.puncture.start && stageRect?.w;
  const rightHalfX = halvesVisible ? armX_r - 90 : 0;  // 0 at puncture, grows →
  const leftHalfX  = halvesVisible ? armX_l + 90 : 0;  // 0 at puncture, grows ←
  const pullRot    = progress('pull') * 4;              // ±4° peel during pull

  // Stable jagged inner-edge points — useMemo so they NEVER re-randomize.
  // Re-randomizing per-frame would make the torn edge "boil."
  const tornEdge = React.useMemo(() => {
    const numPts = 12;
    return Array.from({ length: numPts }, (_, i) => ({
      y:  (i / (numPts - 1)) * 100,
      rx: Math.random() * 14 - 7,   // px jitter for right panel's left (inner) edge
      lx: Math.random() * 14 - 7,   // px jitter for left panel's right (inner) edge
    }));
  }, []);

  let rightClipPath = 'none', leftClipPath = 'none';
  if (stageRect?.w) {
    const cx = stageRect.w / 2;
    // Right panel: jagged inner (left) edge near center, straight right edge
    rightClipPath = `polygon(${
      tornEdge.map(p => `${(cx + p.rx).toFixed(1)}px ${p.y.toFixed(1)}%`).join(', ')
    }, 100% 100%, 100% 0%)`;
    // Left panel: straight left edge, jagged inner (right) edge near center
    leftClipPath = `polygon(0% 0%, 0% 100%, ${
      [...tornEdge].reverse().map(p => `${(cx + p.lx).toFixed(1)}px ${p.y.toFixed(1)}%`).join(', ')
    })`;
  }

  // ── Crack lines (SVG polylines radiating from center at puncture) ──
  const crackLines = React.useMemo(() => {
    const NUM = 9;
    return Array.from({ length: NUM }, (_, i) => {
      const base = (i / NUM) * Math.PI * 2;
      const ang  = base + (Math.random() * 0.5 - 0.25);
      const len  = 45 + Math.random() * 55;
      return [
        [0, 0],
        [Math.cos(ang + (Math.random() * 0.3 - 0.15)) * len * 0.32,
         Math.sin(ang + (Math.random() * 0.3 - 0.15)) * len * 0.32],
        [Math.cos(ang + (Math.random() * 0.2 - 0.10)) * len * 0.66,
         Math.sin(ang + (Math.random() * 0.2 - 0.10)) * len * 0.66],
        [Math.cos(ang) * len, Math.sin(ang) * len],
      ];
    });
  }, []);

  const crackRevP  = Math.max(0, Math.min(1, (t - COLLAPSE_TIMELINE.puncture.start) / 160));
  const crackFadeP = Math.max(0, 1 - Math.max(0, (t - (COLLAPSE_TIMELINE.puncture.start + 280)) / 480));

  // ── Debris (small SVG polygon chips, ballistic + gravity) ──────
  const debris = React.useMemo(() => {
    const NUM = 20;
    return Array.from({ length: NUM }, () => ({
      vx: (Math.random() - 0.5) * 400,
      vy: -(60 + Math.random() * 200),  // upward bias
      sz: 3 + Math.random() * 6,
      r0: Math.random() * 360,
      rv: (Math.random() - 0.5) * 600,
    }));
  }, []);

  const G  = 280;  // gravity px/s²
  const τ  = Math.max(0, (t - COLLAPSE_TIMELINE.puncture.start) / 1000);
  const debrisAlpha = τ > 0 ? Math.max(0, 1 - Math.max(0, (τ - 0.45) / 0.55)) : 0;

  // ── Rip flash — re-timed to puncture start (masks the content swap) ──
  const flashStart   = COLLAPSE_TIMELINE.puncture.start;
  const flashVisible = t >= flashStart && t < flashStart + 220;
  const flashP       = Math.max(0, Math.min(1, (t - flashStart) / 200));
  const flashScale   = 0.5 + flashP * 0.8;
  const flashOpacity = Math.max(0, 1 - flashP);

  // ── Fountain particle finals ────────────────────────────────────
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

  const fountainP     = progress('fountain');
  const fountainEased = 1 - Math.pow(1 - fountainP, 2.6);  // ease-out

  const cx0 = stageRect ? stageRect.w / 2 : 0;
  const cy0 = stageRect ? stageRect.h / 2 : 0;

  // ── Arm render helper (shared by both arms) ─────────────────────
  // rotate(90deg) turns the vertical SVG horizontal: SVG −y → screen +x
  // (shoulder extends away from center); SVG +y → screen −x (fist toward
  // center). mirrorX=true (left arm) flips so fist faces rightward.
  //
  // Knuckle-forward fist: palm block y=5..77 with knuckle bumps at y=77
  // (leading face). Fingers pivot from knuckle base y=77, extend further
  // toward center (+y). Closed grip → fingers bunched tight at face;
  // open hand → fingers fan in SVG x direction (= vertical on screen).
  // Knuckle face at y=77 maps to ~89px from arm center →
  // armX≈90 puts knuckle face ≈ 1px right/left of screen center.
  const renderArm = (armX, armY, armRot, clawOpen, mirrorX) => {
    const fAng = 2 + clawOpen * 22;  // 2=closed fist, 24=full open
    return (
      <svg
        className="mm-robot-arm"
        viewBox="-200 -200 400 400"
        style={{
          left: `calc(50% + ${armX}px)`,
          top:  `calc(50% + ${armY}px)`,
          transform: `translate(-50%, -50%) ${mirrorX ? 'scaleX(-1) ' : ''}rotate(${(90 + armRot).toFixed(2)}deg)`,
          transformOrigin: 'center center',
        }}
        aria-hidden="true"
      >
        {/* Shadow */}
        <ellipse cx="0" cy="40" rx="94" ry="10" fill="rgba(0,0,0,0.30)" />

        {/* Shoulder mount */}
        <rect x="-26" y="-195" width="52" height="52" rx="8"
          fill="oklch(0.28 0.02 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2" />
        <rect x="-16" y="-187" width="32" height="4" rx="2"
          fill="oklch(0.18 0.01 240)" opacity="0.7" />
        <rect x="-16" y="-179" width="32" height="3" rx="1.5"
          fill="oklch(0.18 0.01 240)" opacity="0.4" />

        {/* Piston rod */}
        <rect x="-6" y="-143" width="12" height="18" rx="3"
          fill="oklch(0.28 0.02 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="1.5" />

        {/* Upper arm */}
        <rect x="-34" y="-143" width="68" height="90" rx="16"
          fill="oklch(0.46 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2" />
        <rect x="-24" y="-136" width="48" height="76" rx="10"
          fill="none" stroke="oklch(0.62 0.02 240)" strokeWidth="0.9" opacity="0.40" />
        <line x1="-28" y1="-112" x2="28" y2="-112"
          stroke="oklch(0.20 0.01 240)" strokeWidth="1.5" />

        {/* Elbow */}
        <circle cx="0" cy="-53" r="30"
          fill="oklch(0.32 0.02 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2.5" />
        <circle cx="0" cy="-53" r="13" fill="oklch(0.20 0.01 240)" />
        <circle cx="0" cy="-53" r="5"  fill="oklch(0.56 0.18 250)" />

        {/* Forearm (tapered) */}
        <path d="M -30 -53 L -22 0 L 22 0 L 30 -53 Z"
          fill="oklch(0.50 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2" />
        <rect x="-8" y="-38" width="16" height="28" rx="4"
          fill="oklch(0.34 0.02 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="1.2" />
        {[-25, -12, 1].map((hy, hi) => (
          <line key={hi} x1="-8" y1={hy} x2="8" y2={hy}
            stroke="oklch(0.60 0.02 240)" strokeWidth="0.9" opacity="0.55" />
        ))}

        {/* Wrist */}
        <circle cx="0" cy="0" r="20"
          fill="oklch(0.32 0.02 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2" />
        <circle cx="0" cy="0" r="8" fill="oklch(0.20 0.01 240)" />

        {/* Thumb — extends sideways from palm, fans outward when open */}
        <rect x="36" y="12" width="28" height="16" rx="8"
          transform={`rotate(${fAng * 0.45} 36 20)`}
          fill="oklch(0.42 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="1.5" />

        {/* Palm / fist body — knuckle-forward: leading face is at y=77 */}
        <rect x="-36" y="5" width="72" height="72" rx="15"
          fill="oklch(0.46 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="2.2" />
        {/* Metacarpal crease across mid-palm */}
        <line x1="-30" y1="22" x2="30" y2="22"
          stroke="oklch(0.20 0.01 240)" strokeWidth="1.5" />

        {/* 4 fingers — pivot at knuckle face (y=77), fan in SVG x when open.
            Closed: bunched straight down (large +y = toward center side).
            Open:   fan ±(fi-1.5)*fAng*1.1 degrees in SVG x direction. */}
        {[-21, -7, 7, 21].map((fx, fi) => (
          <rect key={fi}
            x={fx - 8} y="77" width="16" height="52" rx="8"
            transform={`rotate(${(fi - 1.5) * fAng * 1.1} ${fx} 77)`}
            fill="oklch(0.40 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="1.8" />
        ))}

        {/* Knuckle bumps on leading fist face (y≈77) */}
        {[-21, -7, 7, 21].map((fx, fi) => (
          <ellipse key={fi} cx={fx} cy="77" rx="10" ry="6.5"
            fill="oklch(0.36 0.025 240)" stroke="oklch(0.18 0.01 240)" strokeWidth="1.4" />
        ))}
      </svg>
    );
  };

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
      {/* White canvas — only rendered from puncture onward. Torn dark
          panels immediately cover it; it is revealed as they slide apart.
          Not rendered during anticipation so the root stays visually dark. */}
      {t >= COLLAPSE_TIMELINE.puncture.start && <div className="mm-canvas-under" />}

      {/* Torn dark half panels. Appear at puncture, follow arm grip
          positions so the grip reads as physically attached to the chat. */}
      {halvesVisible && (
        <>
          <div
            className="mm-torn-half"
            style={{
              clipPath: rightClipPath,
              transform: `translateX(${rightHalfX.toFixed(1)}px) rotate(${pullRot.toFixed(2)}deg)`,
              transformOrigin: 'left center',
            }}
          />
          <div
            className="mm-torn-half"
            style={{
              clipPath: leftClipPath,
              transform: `translateX(${leftHalfX.toFixed(1)}px) rotate(${(-pullRot).toFixed(2)}deg)`,
              transformOrigin: 'right center',
            }}
          />
        </>
      )}

      {/* Crack lines: SVG polylines shoot out from center at puncture. */}
      {crackRevP > 0 && crackFadeP > 0 && stageRect && (
        <svg
          className="mm-crack-svg"
          width={stageRect.w} height={stageRect.h}
          viewBox={`0 0 ${stageRect.w} ${stageRect.h}`}
        >
          {crackLines.map((pts, i) => {
            const segLens = pts.slice(1).map((p, j) =>
              Math.hypot(p[0] - pts[j][0], p[1] - pts[j][1])
            );
            const totalLen = segLens.reduce((a, b) => a + b, 0) || 1;
            const drawLen  = crackRevP * totalLen;
            return (
              <polyline
                key={i}
                points={pts.map(p => `${(cx0 + p[0]).toFixed(1)},${(cy0 + p[1]).toFixed(1)}`).join(' ')}
                stroke="oklch(0.28 0.01 60)"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={totalLen}
                strokeDashoffset={(totalLen - drawLen).toFixed(2)}
                opacity={crackFadeP}
              />
            );
          })}
        </svg>
      )}

      {/* Debris: small polygon chips with ballistic motion + gravity. */}
      {τ > 0 && debrisAlpha > 0 && stageRect && (
        <svg
          className="mm-crack-svg mm-debris-svg"
          width={stageRect.w} height={stageRect.h}
          viewBox={`0 0 ${stageRect.w} ${stageRect.h}`}
        >
          {debris.map((d, i) => {
            const x   = cx0 + d.vx * τ;
            const y   = cy0 + d.vy * τ + 0.5 * G * τ * τ;
            const rot = d.r0 + d.rv * τ;
            return (
              <polygon
                key={i}
                points={`0,${(-d.sz).toFixed(1)} ${(d.sz*0.7).toFixed(1)},${(d.sz*0.5).toFixed(1)} ${(-d.sz*0.7).toFixed(1)},${(d.sz*0.5).toFixed(1)}`}
                transform={`translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(1)})`}
                fill="oklch(0.22 0.01 60)"
                opacity={debrisAlpha}
              />
            );
          })}
        </svg>
      )}

      {/* Right arm */}
      {armVis_r && stageRect && renderArm(armX_r, armY_r, armRot_r, clawOpen_r, false)}

      {/* Left arm (mirrored via scaleX(-1) so claw points right) */}
      {armVis_l && stageRect && renderArm(armX_l, armY_l, armRot_l, clawOpen_l, true)}

      {/* Rip flash — white radial pop at puncture, masks the content swap. */}
      {flashVisible && (
        <div
          className="mm-impact-flash mm-rip-flash"
          style={{
            opacity: flashOpacity,
            transform: `translate(-50%, -50%) scale(${flashScale.toFixed(2)})`,
          }}
        />
      )}

      {/* Center anchor on white canvas — appears after arms retreat. */}
      {t >= COLLAPSE_TIMELINE.retreat.start && (
        <div className="mm-collide-token mm-token-a mm-anchor-a"
          style={{ left: '50%', top: '50%', opacity: 1, transform: 'translate(-50%, -50%)' }}
        >
          <span className="mm-token-tick" />
          <span>mindmap</span>
        </div>
      )}

      {/* Fountain — trails are drawn ONLY up to the OUTER EDGE of the
          particle's bounding box along the tangent direction. Each
          particle's trail uses the color of the agent it represents,
          cycling through the MM_AGENTS palette. Reads as the 5 agents
          fanning out from the rip and becoming the mindmap categories. */}
      {t >= COLLAPSE_TIMELINE.fountain.start && stageRect && particleFinals.length > 0 && (
        <svg
          className="mm-fountain-svg"
          width={stageRect.w} height={stageRect.h}
          viewBox={`0 0 ${stageRect.w} ${stageRect.h}`}
        >
          {particleFinals.map((p, i) => {
            const u = fountainEased;
            const scale = 0.13 + 0.87 * u;
            const boxHalfW = 110 * scale + 2;
            const boxHalfH = 55 * scale + 2;
            const aHalfW = 78;
            const aHalfH = 14;
            const { d } = partialBezier(
              cx0, cy0,
              cx0 + p.midX, cy0 + p.midY,
              cx0 + p.fx, cy0 + p.fy,
              u, boxHalfW, boxHalfH, aHalfW, aHalfH,
            );
            const trailOpacity = fountainP < 0.06
              ? 0
              : fountainP < 0.82
                ? 0.85
                : Math.max(0, (1 - (fountainP - 0.82) / 0.18)) * 0.85;
            // Per-particle agent color — cycle through MM_AGENTS so
            // each fanning particle visually claims an agent identity.
            const agent = MM_AGENTS[i % MM_AGENTS.length];
            const color = agent.color;
            return (
              <g key={i} style={{ opacity: trailOpacity }}>
                {/* Soft outer glow layer */}
                <path d={d} stroke={color} strokeWidth="3" fill="none"
                  strokeLinecap="round" style={{ opacity: 0.35, filter: 'blur(2.5px)' }} />
                {/* Crisp inner core */}
                <path d={d} stroke={color} strokeWidth="1.2" fill="none"
                  strokeLinecap="round" />
              </g>
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
          const agent = MM_AGENTS[i % MM_AGENTS.length];
          return (
            <div
              key={i}
              className="mm-particle"
              style={{
                left: px, top: py,
                opacity,
                filter: blur ? `blur(${blur.toFixed(1)}px)` : undefined,
                transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
                // Tinted border + halo so each fanning particle carries its
                // agent's visual identity all the way to the settled node.
                borderColor: `color-mix(in oklch, ${agent.color} 70%, transparent)`,
                boxShadow: `0 0 18px color-mix(in oklch, ${agent.color} 35%, transparent)`,
              }}
            >
              <div className="mm-particle-label" style={{ color: agent.color }}>{node.label || '·'}</div>
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

function IdleView({ draft, setDraft, submit, attachments, setAttachments, settings, onTemplatePick }) {
  const [hintIndex, setHintIndex] = React.useState(0);
  const { usage } = useUsage(undefined, settings.useLocal);
  const noProviders = Array.isArray(usage.providers) && usage.providers.length === 0;
  React.useEffect(() => {
    if (draft.trim()) return;
    const id = setInterval(() => {
      setHintIndex((idx) => (idx + 1) % TEMPLATE_KEYS.length);
    }, 5000);
    return () => clearInterval(id);
  }, [draft]);
  const hintKey = TEMPLATE_KEYS[hintIndex % TEMPLATE_KEYS.length];
  const hint = TEMPLATE_DEFS[hintKey];
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
      {noProviders && <section className="mm-setup-card" role="status">
        <strong>No providers configured</strong>
        <span>Copy <code>.env.example</code> to <code>.env</code>, add <code>GEMINI_KEY_1</code> (free at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>), then restart <code>npm run web</code>.</span>
        <div>{['OPENROUTER_KEY', 'GROQ_KEY', 'MISTRAL_KEY', 'CEREBRAS_KEY', 'BRAVE_SEARCH_KEY'].map((key) => <code key={key}>{key}</code>)}</div>
      </section>}
      <div className="mm-composer-wrap">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          autoFocus
          attachments={attachments}
          setAttachments={setAttachments}
          settings={settings}
          placeholder={`› ${hint?.starter || 'Describe what you need'}`}
        />
      </div>
      <div className="mm-template-row">
        {TEMPLATE_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className="mm-template-hint"
            style={{ '--c': TEMPLATE_DEFS[k].accent }}
            onClick={() => onTemplatePick(k)}
            title={TEMPLATE_DEFS[k].starter}
          >
            <i /> {TEMPLATE_DEFS[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}

// LoadingView — reflects the REAL live status from the streaming
// ChatSession run when available. Falls back to a gentle ambient
// cycle when no live data exists (e.g. legacy non-streaming code path).
// Each agent row's state is driven by the SSE events:
//   plan-start          → orchestrator is "deciding…"
//   role-start single   → that specialist is "thinking…"
//   role-start parallel → multiple specialists "thinking…" concurrently
//   role-start synth    → orchestrator is "synthesizing…"
//   role-end            → marks the agent as "done"
function LoadingView({ prompt, liveStatus, summarize, agentState }) {
  // Agent state ACCUMULATES across events, but the accumulation now
  // happens in the DATA layer (see `applyAgentEvent` / the SSE loop in
  // HeroMindmap.submit) rather than here. The old render-layer reducer
  // (useState + useEffect keyed on liveStatus) only ever saw the LAST
  // event of a synchronous burst because React batches the setLiveTurn
  // calls — so in round-robin mode only the final 1–2 roles ever lit up.
  // We now receive the already-accumulated map as a prop and just render
  // it; `makeInitialAgentMap()` covers the pre-first-event frame.
  const agents = agentState || makeInitialAgentMap();

  const fallbackHint = !liveStatus ? 'routing…' : (
    summarize?.folded
      ? `auto-summarized ${summarize.folded} older turn(s)`
      : (liveStatus.kind === 'plan-start' ? 'orchestrator planning'
        : liveStatus.kind === 'role-start' ? 'specialist working'
        : liveStatus.kind === 'role-end' ? 'integrating' : 'thinking')
  );

  return (
    <div className="mm-phase mm-phase-loading">
      <div className="mm-prompt-card">
        <div className="mm-prompt-head">
          <span className="mm-prompt-tag">your prompt</span>
          <span className="mm-routing-pill">{fallbackHint}</span>
        </div>
        <div className="mm-prompt-body">{prompt}</div>
      </div>
      <div className="mm-dispatch">
        {MM_AGENTS.map((a) => {
          const s = agents[a.id] || { state: 'queued', label: 'queued' };
          return (
            <div key={a.id}
              className={'mm-dispatch-row mm-dispatch-' + s.state}
              style={{ '--c': a.color }}>
              <span className="orb" />
              <span className="nm">{a.name}</span>
              <span className="st">{s.label}</span>
            </div>
          );
        })}
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
  draft, setDraft, submit, responses, expand, reset, phase, liveTurn,
  attachments, setAttachments, burstError, onApplyEdit, onReviewArtifact, onUndoArtifact, onOpenArtifactFiles, onRetryTurn, retryDisabled, settings,
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
  const partialLen = liveTurn?.partial?.length || 0;
  const [isNearBottom, setIsNearBottom] = React.useState(true);
  const updateNearBottom = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setIsNearBottom(list.scrollHeight - list.scrollTop - list.clientHeight < 80);
  }, []);
  const scrollToLatest = React.useCallback(() => {
    const list = listRef.current;
    const bottom = bottomRef.current;
    if (!list || !bottom) return;
    try {
      bottom.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      list.scrollTop = list.scrollHeight;
    }
  }, []);
  React.useEffect(() => {
    updateNearBottom();
  }, [responses.length, partialLen, updateNearBottom]);
  // Trigger when newest id changes (new completed turn) OR when a live
  // turn is streaming so the partial bubble keeps sticking to the bottom
  // as tokens arrive. The auto-scroll only happens if the user is
  // already near the bottom — otherwise they may be reading older turns.
  React.useEffect(() => {
    const list = listRef.current;
    const bottom = bottomRef.current;
    if (!list || !bottom) return;
    const idChanged = lastIdRef.current !== newest?.id;
    if (!idChanged && !imploding && !liveTurn) return;
    lastIdRef.current = newest?.id;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    if (!idChanged && !imploding && !nearBottom) return;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(scrollToLatest, 80)));
  }, [newest?.id, imploding, responses.length, partialLen, liveTurn?.status?.kind, scrollToLatest]);

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
            dataState={
              newest?.data ? 'ready'
                : newest?.dataLoading ? 'structuring'
                  : newest?.dataError ? 'failed'
                    : 'ready'
            }
            errorMessage={burstError}
          />
        )}
        <div className="mm-chat-list" ref={listRef} onScroll={updateNearBottom}>
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
              isNewest={i === responses.length - 1 && !liveTurn}
              onApplyEdit={onApplyEdit}
              onReviewArtifact={onReviewArtifact}
              onUndoArtifact={onUndoArtifact}
              onOpenArtifactFiles={onOpenArtifactFiles}
              onRetry={(automatic) => onRetryTurn?.(entry, automatic)}
              retryDisabled={retryDisabled}
            />
          ))}
          {/* In-flight turn: shows the user prompt + the partial AI bubble
              as tokens stream in. When the turn finishes, the parent moves
              it into `responses` and clears liveTurn so this re-renders as
              a normal ChatTurn. */}
          {liveTurn && (
            <ChatTurn
              key="__live__"
              entry={{
                id: '__live__',
                prompt: liveTurn.prompt,
                template: 'plan',
                text: liveTurn.partial || '',
              streaming: true,
              status: liveTurn.status,
              toolActivity: liveTurn.toolActivity,
              }}
              accent={accent}
              isNewest={true}
            />
          )}
          {/* Scroll anchor — scrollIntoView target so smooth-scroll
              survives heavy-render newest turns. */}
          <div ref={bottomRef} className="mm-chat-anchor" aria-hidden="true" />
        </div>
        {liveTurn && !isNearBottom && (
          <button type="button" className="mm-jump-latest" onClick={scrollToLatest}>
            <span aria-hidden="true">↓</span>
            streaming...
          </button>
        )}
        <div className="mm-chat-composer">
          <Composer value={draft} onChange={setDraft} onSubmit={submit} attachments={attachments} setAttachments={setAttachments} settings={settings} />
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
  const nodeRef = React.useRef(null);
  React.useEffect(() => {
    const mj = window.MathJax;
    if (mj?.typesetPromise && nodeRef.current) {
      mj.typesetPromise([nodeRef.current]).catch(() => {});
    }
  }, [node]);
  return (
    <div
      ref={nodeRef}
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
function FocusedNodeView({ node, accent, onBack, draft, setDraft, submit, attachments, setAttachments, settings }) {
  const bodyRef = React.useRef(null);
  React.useEffect(() => {
    const mj = window.MathJax;
    if (mj?.typesetPromise && bodyRef.current) {
      mj.typesetPromise([bodyRef.current]).catch(() => {});
    }
  }, [node]);
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
        <div className="mm-focus-body-scroll" ref={bodyRef}>
          {node.body}
        </div>
      </div>
      <div className="mm-focus-composer-wrap">
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus attachments={attachments} setAttachments={setAttachments} settings={settings} />
      </div>
    </div>
  );
}

function OrbitalMindmap({
  responses, collapse, reset, phase,
  draft, setDraft, submit,
  attachments, setAttachments, settings,
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
        attachments={attachments} setAttachments={setAttachments}
        settings={settings}
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
          <ImageTurnIndicator entry={newest} />
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
          <Composer value={draft} onChange={setDraft} onSubmit={submit} attachments={attachments} setAttachments={setAttachments} settings={settings} />
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
const SESSION_LS_KEY = 'lattice.chatSessionId.v1';
const SETTINGS_LS_KEY = 'lattice.settings.v1';
const DRAFT_LS_PREFIX = 'lattice.draft.v1:';

// Persistent user-tunable knobs that mirror CLI flags one-for-one:
//   serious  → thinking: "high"  (Gemini extended reasoning on every call)
//   search   → useSearch: true   (Google Search grounding on the perception primary)
//   role     → forceRole (one of RoleName) | 'auto' (let smart-routing decide)
//   routingMode → 'fast' | 'smart' | 'round-robin' (default fast)
// All knobs persist to localStorage so refresh / new tab keeps the user's
// chosen mode. The settings drawer surfaces routingMode and forceRole as
// a single merged dropdown (see ROUTING_OPTIONS) — internally they remain
// independent so the wire format with the server is unchanged.
const DEFAULT_SETTINGS = { serious: false, search: false, builder: false, forceRole: 'auto', useLocal: false, routingMode: 'fast', theme: 'clay' };

// Merged dropdown that replaces the prior separate Force-role select + a
// Smart-vs-RoundRobin radio group. Two "meta" entries on top combine the
// routingMode field with forceRole='auto'; the rest pin a specific role
// and use smart routing under the hood. Fast is the default so the first
// visible answer token does not wait for orchestration.
const ROUTING_OPTIONS = [
  { value: 'fast',              label: 'fast (default)',               routingMode: 'fast',        forceRole: 'auto' },
  { value: 'multi-agent',       label: 'deep multi-agent',             routingMode: 'multi-agent', forceRole: 'auto' },
  { value: 'brainstorming',     label: 'brainstorming',                routingMode: 'brainstorming', forceRole: 'auto' },
  { value: 'auto',              label: 'auto',                         routingMode: 'smart',       forceRole: 'auto' },
  { value: 'orchestration',     label: 'orchestration',                routingMode: 'smart',       forceRole: 'orchestration' },
  { value: 'perception',        label: 'perception (search grounding)', routingMode: 'smart',      forceRole: 'perception' },
  { value: 'reasoning',         label: 'reasoning (deliberation)',     routingMode: 'smart',       forceRole: 'reasoning' },
  { value: 'action-code',       label: 'action-code (Codestral)',      routingMode: 'smart',       forceRole: 'action-code' },
  { value: 'action-structural', label: 'action-structural (Llama 70B)', routingMode: 'smart',      forceRole: 'action-structural' },
  { value: 'action-repetitive', label: 'action-repetitive (Cerebras)', routingMode: 'smart',       forceRole: 'action-repetitive' },
];

// Resolve the current (routingMode, forceRole) pair to a single dropdown
// value. Falls back to 'round-robin' (the default) when no exact match
// exists — protects against stale localStorage from prior schema.
function routingValueFromSettings(s) {
  if (s.routingMode === 'fast') return 'fast';
  if (s.routingMode === 'round-robin') return 'brainstorming';
  if (s.routingMode === 'brainstorming') return 'brainstorming';
  if (s.routingMode === 'multi-agent') return 'multi-agent';
  if (s.routingMode === 'smart' && (!s.forceRole || s.forceRole === 'auto')) return 'auto';
  if (s.forceRole && s.forceRole !== 'auto') return s.forceRole;
  return 'fast';
}

const VALID_FORCE_ROLES = new Set(['auto', 'orchestration', 'perception', 'reasoning', 'action-code', 'action-structural', 'action-repetitive']);
const VALID_ROUTING_MODES = new Set(['fast', 'smart', 'round-robin', 'multi-agent', 'brainstorming']);
const VALID_THEMES = new Set(['clay', 'paper']);

function runtimeDefaultUseLocal() {
  return window.__MULTI_AGENT_RUNTIME__ && window.__MULTI_AGENT_RUNTIME__.defaultUseLocal === true;
}

function runtimeChatOnly() {
  return window.__MULTI_AGENT_RUNTIME__ && window.__MULTI_AGENT_RUNTIME__.chatOnly === true;
}

const CHAT_ONLY = runtimeChatOnly();

function loadSettings() {
  if (CHAT_ONLY) {
    return { ...DEFAULT_SETTINGS, builder: false, useLocal: runtimeDefaultUseLocal() };
  }
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, useLocal: runtimeDefaultUseLocal() };
    const parsed = JSON.parse(raw);
    return {
      serious: typeof parsed.serious === 'boolean' ? parsed.serious : false,
      search:  typeof parsed.search  === 'boolean' ? parsed.search  : false,
      builder: typeof parsed.builder === 'boolean' ? parsed.builder : false,
      forceRole: VALID_FORCE_ROLES.has(parsed.forceRole) ? parsed.forceRole : 'auto',
      useLocal: typeof parsed.useLocal === 'boolean' ? parsed.useLocal : false,
      routingMode: VALID_ROUTING_MODES.has(parsed.routingMode) ? parsed.routingMode : DEFAULT_SETTINGS.routingMode,
      theme: VALID_THEMES.has(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, useLocal: runtimeDefaultUseLocal() };
  }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(s)); } catch {}
}
const IMPLODE_DURATION_MS = 440;

function loadSessionId() {
  try {
    const existing = localStorage.getItem(SESSION_LS_KEY);
    if (existing) return existing;
    const created = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SESSION_LS_KEY, created);
    return created;
  } catch {
    return 'web-' + Date.now().toString(36);
  }
}
function resetSessionId() {
  const next = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  try { localStorage.setItem(SESSION_LS_KEY, next); } catch {}
  return next;
}

function persistSessionId(id) {
  try { localStorage.setItem(SESSION_LS_KEY, id); } catch {}
}

function loadSessionDraft(id) {
  try {
    const value = localStorage.getItem(DRAFT_LS_PREFIX + id) || '';
    return value.length <= 8192 ? value : '';
  } catch { return ''; }
}

function clearSessionDraft(id) {
  try { localStorage.removeItem(DRAFT_LS_PREFIX + id); } catch {}
}

function sanitizeGeneratedTitle(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'“”]+|["'“”.,:;!?]+$/g, '').trim();
  if (!title || title.length > 48 || /[.!?]\s+\S/.test(title)) return null;
  return title;
}

async function generateSessionTitle(sessionId, prompt, reply) {
  try {
    const response = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'action-repetitive',
        prompt: `Write a concise title (2-7 words, one line, no quotes or punctuation) for this conversation.\nUser: ${prompt}\nReply: ${String(reply).slice(0, 400)}`,
      }),
    });
    if (!response.ok) return;
    const title = sanitizeGeneratedTitle((await response.json()).reply);
    if (!title) return;
    await fetch('/api/sessions/' + encodeURIComponent(sessionId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
  } catch {}
}

function responsesFromSessionHistory(sessionId, history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let turn = 0;
  for (let i = 0; i < history.length; i++) {
    const user = history[i];
    if (!user || user.kind !== 'user_text' || typeof user.text !== 'string') continue;
    const model = history.slice(i + 1).find((p) => p && p.kind === 'model_text' && typeof p.text === 'string');
    const prompt = user.text;
    const text = model?.text || '';
    out.push({
      id: `${sessionId}_${turn++}`,
      prompt,
      template: detectTemplate(prompt),
      text,
      servedBy: [],
      plan: null,
      tokenEstimate: 0,
      tokenBudget: 100000,
      budgetPct: 0,
      turns: turn,
      warning: null,
      data: null,
      dataLoading: false,
      dataError: false,
    });
  }
  return out.filter((r) => r.text || r.prompt);
}

function loadPersistedStack() {
  try {
    const raw = localStorage.getItem(STACK_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) =>
      e && typeof e.id === 'string' && typeof e.prompt === 'string' &&
      e.response && TEMPLATE_DEFS[e.response.template]
    ).map((e) => ({
      id: e.id,
      prompt: e.prompt,
      imageCount: e.imageCount || 0,
      ...e.response,
      artifact: e.response.artifact || e.response.artifactSlim || null,
    }));
  } catch { return []; }
}
function savePersistedStack(responses) {
  try {
    const slim = responses.map((r) => ({
      id: r.id, prompt: r.prompt,
      // Persist only the image COUNT, never the base64 (localStorage quota).
      imageCount: r.imageCount || (r.images ? r.images.length : 0),
      response: {
        template: r.template,
        text: r.text,
        data: r.data,
        servedBy: r.servedBy,
        plan: r.plan,
        tokenEstimate: r.tokenEstimate,
        tokenBudget: r.tokenBudget,
        budgetPct: r.budgetPct,
        turns: r.turns,
        warning: r.warning,
        error: r.error || null,
        autoRetryAllowed: r.autoRetryAllowed !== false,
        artifactSlim: r.artifact ? {
          projectId: r.artifact.projectId,
          projectName: r.artifact.projectName,
          projectRevision: r.artifact.projectRevision,
          sessionId: r.artifact.sessionId,
          sourceTurnId: r.artifact.sourceTurnId,
          candidates: (r.artifact.candidates || []).map((candidate) => ({
            path: candidate.path,
            bytes: Number.isFinite(candidate.bytes) ? candidate.bytes : new TextEncoder().encode(candidate.content || '').length,
          })),
        } : null,
        artifactReceipt: r.artifactReceipt || null,
        toolActivity: Array.isArray(r.toolActivity) ? r.toolActivity : [],
      },
    }));
    localStorage.setItem(STACK_LS_KEY, JSON.stringify(slim));
  } catch {}
}
function clearPersistedStack() {
  try { localStorage.removeItem(STACK_LS_KEY); } catch {}
}

// Tiny error boundary used to wrap the orbital phase. Without this, a
// thrown error inside any descendant component unmounts the whole
// React tree → the page goes black with no error message. With it,
// we catch the error and render a recoverable panel that lets the
// user collapse back to the chat.
class PhaseErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[phase-error]', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      const msg = String(this.state.error?.message || this.state.error || 'unknown error');
      const label = this.props.label || 'mindmap';
      const recoverLabel = this.props.recoverLabel || '← back to chat';
      return (
        <div className="mm-phase mm-phase-error" role="alert">
          <div className="mm-phase-error-card">
            <div className="mm-phase-error-title">{label} render failed</div>
            <div className="mm-phase-error-msg">{msg}</div>
            <button
              className="mm-phase-error-back"
              onClick={() => {
                // Clear our error before delegating to the parent's recover.
                // Without the reset, a re-mount that hits the same bug would
                // never repaint because getDerivedStateFromError already
                // latched us into the error state.
                this.setState({ error: null });
                this.props.onRecover?.();
              }}
            >
              {recoverLabel}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

let csrfTokenPromise = null;

function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch('/api/security/context')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || typeof body.csrfToken !== 'string') {
          throw new Error(body.error || 'Could not establish a secure local session');
        }
        return body.csrfToken;
      })
      .catch((error) => {
        csrfTokenPromise = null;
        throw error;
      });
  }
  return csrfTokenPromise;
}

function secureMutationFetch(url, init = {}) {
  return getCsrfToken().then((csrfToken) => {
    const headers = new Headers(init.headers || {});
    headers.set('X-CSRF-Token', csrfToken);
    return fetch(url, { ...init, headers });
  });
}

function FileDrawer({ open, onClose, attachments, setAttachments, preload, onPreloadConsumed, refreshToken }) {
  const [rootInfo, setRootInfo] = React.useState(null);
  const [currentPath, setCurrentPath] = React.useState('.');
  const [entries, setEntries] = React.useState([]);
  const [selectedFile, setSelectedFile] = React.useState(null);
  const [listError, setListError] = React.useState(null);
  const [previewError, setPreviewError] = React.useState(null);
  const [listLoading, setListLoading] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  // edit / diff / apply state
  const [editMode, setEditMode] = React.useState(false);
  const [editContent, setEditContent] = React.useState('');
  const [diffResult, setDiffResult] = React.useState(null); // { path, beforeSha256, diff }
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [applyLoading, setApplyLoading] = React.useState(false);
  const [applyError, setApplyError] = React.useState(null);
  // project selector state
  const [projects, setProjects] = React.useState([]);
  const [projActiveId, setProjActiveId] = React.useState(null);
  const [projAllowList, setProjAllowList] = React.useState([]);
  const [projSwitching, setProjSwitching] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addName, setAddName] = React.useState('');
  const [addPath, setAddPath] = React.useState('');
  const [addCreateRoot, setAddCreateRoot] = React.useState(false);
  const [addError, setAddError] = React.useState(null);
  const [addLoading, setAddLoading] = React.useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState(null);
  const [pinLoading, setPinLoading] = React.useState(false);
  // incremented to force a file-list re-fetch even when currentPath doesn't change
  const [listKey, setListKey] = React.useState(0);

  function fetchProjects() {
    return fetch('/api/projects').then(r => r.json()).then(j => {
      setProjects(j.projects || []);
      setProjActiveId(j.active?.id || null);
      setProjAllowList(j.allowList || []);
    }).catch(() => {});
  }

  function fetchRoot() {
    return fetch('/api/files/root').then(r => r.json()).then(j => setRootInfo(j)).catch(() => {});
  }

  React.useEffect(() => {
    if (!open) return;
    fetchRoot();
    fetchProjects();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setListError(null);
    setListLoading(true);
    fetch('/api/files?path=' + encodeURIComponent(currentPath))
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error ' + r.status); setEntries(j.entries || []); })
      .catch(e => setListError(e.message))
      .finally(() => setListLoading(false));
  }, [open, currentPath, listKey]);

  React.useEffect(() => {
    if (open) setListKey((key) => key + 1);
  }, [open, refreshToken]);

  React.useEffect(() => {
    if (!open) {
      setCurrentPath('.'); setEntries([]); setSelectedFile(null);
      setListError(null); setPreviewError(null);
      setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
      setAddOpen(false); setAddName(''); setAddPath(''); setAddCreateRoot(false); setAddError(null);
      setDeleteConfirmId(null);
    }
  }, [open]);

  // Preload: when opened from a chat "apply" button, auto-fetch the target file,
  // pre-fill the editor with the proposed content, and jump straight to diff view.
  React.useEffect(() => {
    if (!open || !preload) return;
    onPreloadConsumed && onPreloadConsumed();
    setPreviewError(null); setPreviewLoading(true); setSelectedFile(null);
    setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
    fetch('/api/files/read?path=' + encodeURIComponent(preload.path))
      .then(async r => {
        const j = await r.json();
        if (!r.ok && r.status !== 404) throw new Error(j.error || 'Error ' + r.status);
        const target = r.ok
          ? j
          : { path: preload.path, content: '', size: 0, sha256: null, truncated: false };
        setSelectedFile(target);
        setEditContent(preload.content);
        // Missing files receive a create preview from the same endpoint.
        return fetch('/api/files/diff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target.path, content: preload.content }),
        }).then(async dr => {
          const dj = await dr.json();
          if (!dr.ok) throw new Error(dj.error || 'Diff error');
          setDiffResult(dj);
          setEditMode(true);
        });
      })
      .catch(e => setPreviewError(e.message))
      .finally(() => setPreviewLoading(false));
  }, [open, preload]);

  // Auto-open pinned file when drawer opens (if one is set)
  React.useEffect(() => {
    if (!open || !rootInfo?.pinnedFile) return;
    setPreviewError(null); setPreviewLoading(true); setSelectedFile(null);
    fetch('/api/files/read?path=' + encodeURIComponent(rootInfo.pinnedFile))
      .then(async r => { const j = await r.json(); if (!r.ok) return; setSelectedFile(j); })
      .catch(() => {})
      .finally(() => setPreviewLoading(false));
  }, [open, rootInfo?.pinnedFile]);

  function switchProject(id) {
    if (id === projActiveId) return;
    setProjSwitching(true);
    secureMutationFetch('/api/projects/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(async r => {
      if (!r.ok) return;
      await Promise.all([fetchRoot(), fetchProjects()]);
      // Reset to root and force re-fetch even if currentPath is already '.'
      setCurrentPath('.');
      setSelectedFile(null); setPreviewError(null);
      setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
      setListKey(k => k + 1);
    }).catch(() => {}).finally(() => setProjSwitching(false));
  }

  function submitAddProject(e) {
    e.preventDefault();
    if (!addName.trim() || !addPath.trim()) return;
    setAddLoading(true); setAddError(null);
    secureMutationFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: addName.trim(), root: addPath.trim(), createRoot: addCreateRoot }),
    }).then(async r => {
      const j = await r.json();
      if (!r.ok) { setAddError(j.error || 'Error ' + r.status); return; }
      setAddOpen(false); setAddName(''); setAddPath(''); setAddCreateRoot(false);
      await fetchProjects();
    }).catch(e => setAddError(e.message)).finally(() => setAddLoading(false));
  }

  function deleteProject(id) {
    secureMutationFetch('/api/projects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(async r => {
      if (!r.ok) return;
      setDeleteConfirmId(null);
      await Promise.all([fetchRoot(), fetchProjects()]);
      setCurrentPath('.');
      setSelectedFile(null); setPreviewError(null);
      setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
      setListKey(k => k + 1);
    }).catch(() => {});
  }

  function togglePin() {
    if (!selectedFile) return;
    const isPinned = rootInfo?.pinnedFile === selectedFile.path;
    setPinLoading(true);
    secureMutationFetch('/api/projects/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: isPinned ? null : selectedFile.path }),
    }).then(async r => {
      if (!r.ok) return;
      await fetchRoot();
    }).catch(() => {}).finally(() => setPinLoading(false));
  }

  function navigateTo(path) {
    setCurrentPath(path); setSelectedFile(null); setPreviewError(null);
    setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
  }

  function loadFile(entry) {
    setPreviewError(null); setPreviewLoading(true); setSelectedFile(null);
    setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null);
    fetch('/api/files/read?path=' + encodeURIComponent(entry.path))
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error ' + r.status); setSelectedFile(j); })
      .catch(e => setPreviewError(e.message))
      .finally(() => setPreviewLoading(false));
  }

  function attachFile() {
    if (!selectedFile) return;
    const current = attachments || [];
    const totalCurrent = current.reduce((s, a) => s + (a.size || attachmentText(a).length), 0);
    if (totalCurrent + selectedFile.size > ATTACH_TOTAL_MAX_BYTES) {
      setPreviewError('Would exceed total ' + (ATTACH_TOTAL_MAX_BYTES / 1024) + ' KB attachment cap');
      return;
    }
    if (current.some(a => a.name === selectedFile.path)) { setPreviewError('This file is already attached'); return; }
    setAttachments([...current, { name: selectedFile.path, size: selectedFile.size, text: selectedFile.content }]);
    onClose();
  }

  function enterEdit() {
    if (!selectedFile) return;
    setEditContent(selectedFile.content);
    setDiffResult(null); setApplyError(null);
    setEditMode(true);
  }

  function cancelEdit() { setEditMode(false); setEditContent(''); setDiffResult(null); setApplyError(null); }

  function previewDiff() {
    if (!selectedFile) return;
    setDiffLoading(true); setDiffResult(null); setApplyError(null);
    fetch('/api/files/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedFile.path, content: editContent }),
    })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error ' + r.status); setDiffResult(j); })
      .catch(e => setApplyError(e.message))
      .finally(() => setDiffLoading(false));
  }

  function applyWrite() {
    if (!selectedFile || !diffResult) return;
    setApplyLoading(true); setApplyError(null);
    secureMutationFetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedFile.path, content: editContent, expectedSha256: diffResult.beforeSha256, confirm: true }),
    })
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
        // Reload the file to get the new sha256 + content
        return fetch('/api/files/read?path=' + encodeURIComponent(selectedFile.path));
      })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error ' + r.status); setSelectedFile(j); setEditMode(false); setEditContent(''); setDiffResult(null); })
      .catch(e => setApplyError(e.message))
      .finally(() => setApplyLoading(false));
  }

  function buildCrumbs() {
    const rootLabel = rootInfo ? (rootInfo.root.replace(/\\/g, '/').split('/').pop() || 'root') : 'root';
    if (!currentPath || currentPath === '.') return [{ label: rootLabel, path: '.' }];
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const crumbs = [{ label: rootLabel, path: '.' }];
    let acc = '';
    for (const part of parts) { acc = acc ? acc + '/' + part : part; crumbs.push({ label: part, path: acc }); }
    return crumbs;
  }

  if (!open) return null;
  const crumbs = buildCrumbs();
  const alreadyAttached = selectedFile && (attachments || []).some(a => a.name === selectedFile.path);
  const totalAttached = (attachments || []).reduce((s, a) => s + (a.size || 0), 0);
  const wouldExceedCap = selectedFile && (totalAttached + selectedFile.size > ATTACH_TOTAL_MAX_BYTES);
  const diffLines = diffResult?.diff ? diffResult.diff.split('\n') : [];

  return (
    <aside className="mm-file-drawer" aria-label="Project file browser">
      <div className="mm-session-backdrop" onClick={onClose} />
      <div className="mm-file-panel">
        <div className="mm-file-head">
          <div>
            <div className="mm-session-kicker">files</div>
            <h2>Project Files</h2>
          </div>
          <button className="mm-session-close" onClick={onClose} aria-label="Close file browser">close</button>
        </div>
        {/* ── Project selector ── */}
        {projects.length > 0 && (
          <div className="mm-proj-selector">
            <div className="mm-proj-row">
              <select
                className="mm-proj-select"
                value={projActiveId || ''}
                disabled={projSwitching}
                onChange={e => switchProject(e.target.value)}
                aria-label="Active project"
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                className="mm-proj-add-btn"
                onClick={() => { setAddOpen(o => !o); setAddError(null); setAddName(''); setAddPath(''); setAddCreateRoot(false); }}
                title="Add new project"
                aria-label="Add new project"
              >＋</button>
              {projects.length > 1 && (
                deleteConfirmId === projActiveId
                  ? <span className="mm-proj-confirm">
                      Remove?&nbsp;
                      <button className="mm-proj-confirm-yes" onClick={() => deleteProject(projActiveId)}>yes</button>
                      &nbsp;/&nbsp;
                      <button className="mm-proj-confirm-no" onClick={() => setDeleteConfirmId(null)}>no</button>
                    </span>
                  : <button
                      className="mm-proj-del-btn"
                      onClick={() => setDeleteConfirmId(projActiveId)}
                      title="Remove active project"
                      aria-label="Remove active project"
                    >🗑</button>
              )}
            </div>
            {addOpen && (
              <form className="mm-proj-add-form" onSubmit={submitAddProject}>
                <input
                  className="mm-proj-input"
                  placeholder="Name"
                  value={addName}
                  onChange={e => setAddName(e.target.value)}
                  required
                />
                <input
                  className="mm-proj-input"
                  placeholder={rootInfo ? rootInfo.root.replace(/[^\\/]+$/, 'projects/my-project') : 'Absolute path'}
                  value={addPath}
                  onChange={e => setAddPath(e.target.value)}
                  required
                />
                <label className="mm-proj-create-root">
                  <input
                    type="checkbox"
                    checked={addCreateRoot}
                    onChange={e => setAddCreateRoot(e.target.checked)}
                  />
                  Create this folder if it does not exist
                </label>
                <div className="mm-proj-add-actions">
                  <button type="submit" className="mm-proj-save-btn" disabled={addLoading}>
                    {addLoading ? 'Adding…' : 'Add'}
                  </button>
                  <button type="button" className="mm-proj-cancel-btn" onClick={() => setAddOpen(false)}>cancel</button>
                </div>
                {addError && <div className="mm-file-error">{addError}</div>}
              </form>
            )}
          </div>
        )}
        <nav className="mm-file-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i > 0 && <span className="mm-file-crumb-sep">/</span>}
              {i === crumbs.length - 1
                ? <span className="mm-file-crumb current">{c.label}</span>
                : <button className="mm-file-crumb" onClick={() => navigateTo(c.path)}>{c.label}</button>}
            </React.Fragment>
          ))}
        </nav>
        <div className="mm-file-body">
          <div className="mm-file-list-pane">
            {listLoading && <div className="mm-file-status">loading…</div>}
            {listError && <div className="mm-file-error">{listError}</div>}
            {!listLoading && !listError && entries.length === 0 && (
              <EmptyState>Empty folder.</EmptyState>
            )}
            {!listLoading && !listError && entries.map(entry => (
              <button
                key={entry.path}
                className={'mm-file-entry ' + entry.kind + (selectedFile && selectedFile.path === entry.path ? ' selected' : '')}
                onClick={() => entry.kind === 'dir' ? navigateTo(entry.path) : loadFile(entry)}
                disabled={entry.kind === 'file' && !entry.readable}
              >
                <span className="mm-file-icon">{entry.kind === 'dir' ? '▶' : '·'}</span>
                <span className="mm-file-name">{entry.name}</span>
                {entry.kind === 'file' && entry.size != null && (
                  <span className="mm-file-size">{entry.size >= 1024 ? (entry.size / 1024).toFixed(0) + ' KB' : entry.size + ' B'}</span>
                )}
              </button>
            ))}
          </div>
          <div className="mm-file-preview-pane">
            {previewLoading && <div className="mm-file-status">loading preview…</div>}
            {previewError && <div className="mm-file-error">{previewError}</div>}
            {!previewLoading && !previewError && selectedFile && !editMode && (
              <>
                <div className="mm-file-preview-meta">
                  <span className="mm-file-preview-path">{selectedFile.path}</span>
                  <span className="mm-file-preview-size">{selectedFile.size >= 1024 ? (selectedFile.size / 1024).toFixed(0) + ' KB' : selectedFile.size + ' B'}</span>
                  <button
                    className={'mm-file-pin-btn' + (rootInfo?.pinnedFile === selectedFile.path ? ' pinned' : '')}
                    onClick={togglePin}
                    disabled={pinLoading}
                    title={rootInfo?.pinnedFile === selectedFile.path ? 'Unpin this file' : 'Pin this file as project focus'}
                    aria-label={rootInfo?.pinnedFile === selectedFile.path ? 'Unpin' : 'Pin'}
                  >★</button>
                </div>
                <pre className="mm-file-preview-content">{selectedFile.content}</pre>
                <div className="mm-file-preview-actions">
                  <button className="mm-file-edit-btn" onClick={enterEdit} title="Edit this file">edit</button>
                  {alreadyAttached
                    ? <span className="mm-file-attached-note">✓ already attached</span>
                    : <button
                        className="mm-file-attach-btn"
                        onClick={attachFile}
                        disabled={!!wouldExceedCap}
                        title={wouldExceedCap ? 'Would exceed total attachment cap' : 'Attach this file to the current chat prompt'}
                      >attach to chat</button>}
                </div>
              </>
            )}
            {!previewLoading && selectedFile && editMode && !diffResult && (
              <>
                <div className="mm-file-preview-meta">
                  <span className="mm-file-preview-path">{selectedFile.path} · editing</span>
                </div>
                <textarea
                  className="mm-file-edit-area"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  spellCheck={false}
                />
                {applyError && <div className="mm-file-error">{applyError}</div>}
                <div className="mm-file-preview-actions">
                  <button className="mm-file-attach-btn" onClick={previewDiff} disabled={diffLoading || editContent === selectedFile.content}>
                    {diffLoading ? 'computing…' : 'preview diff'}
                  </button>
                  <button className="mm-file-edit-btn" onClick={cancelEdit}>cancel</button>
                </div>
              </>
            )}
            {!previewLoading && selectedFile && editMode && diffResult && (
              <>
                <div className="mm-file-preview-meta">
                  <span className="mm-file-preview-path">{selectedFile.path} · diff preview</span>
                </div>
                {diffResult.diff
                  ? <div className="mm-file-diff">
                      {diffLines.map((line, i) => (
                        <div key={i} className={'mm-diff-line' + (line.startsWith('+') && !line.startsWith('+++') ? ' add' : line.startsWith('-') && !line.startsWith('---') ? ' del' : line.startsWith('@@') ? ' hunk' : '')}>
                          {line}
                        </div>
                      ))}
                    </div>
                  : <div className="mm-file-status">No changes.</div>}
                {applyError && <div className="mm-file-error">{applyError}</div>}
                <div className="mm-file-preview-actions">
                  <button className="mm-file-attach-btn" onClick={applyWrite} disabled={applyLoading || !diffResult.diff}>
                    {applyLoading ? 'applying…' : 'apply'}
                  </button>
                  <button className="mm-file-edit-btn" onClick={() => { setDiffResult(null); setApplyError(null); }}>back to edit</button>
                  <button className="mm-file-edit-btn" onClick={cancelEdit}>cancel</button>
                </div>
              </>
            )}
            {!previewLoading && !previewError && !selectedFile && (
              <div className="mm-file-preview-empty">
                <EmptyState>Select a file to preview.</EmptyState>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function ConversationDrawer({
  open,
  sessions,
  query,
  setQuery,
  currentId,
  busy,
  onClose,
  onRefresh,
  onOpenSession,
  onRenameSession,
  onTogglePin,
  onDuplicateSession,
  onDeleteSession,
  onDeleteAllSessions,
  onExportSession,
  onExportMarkdown,
  onClearCurrent,
}) {
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.preview || '').toLowerCase().includes(q) ||
      (s.id || '').toLowerCase().includes(q)
    );
  }, [sessions, query]);

  if (!open) return null;
  return (
    <aside className="mm-session-drawer" aria-label="Conversation manager">
      <div className="mm-session-backdrop" onClick={onClose} />
      <div className="mm-session-panel">
        <div className="mm-session-head">
          <div>
            <div className="mm-session-kicker">threads</div>
            <h2>Conversation Manager</h2>
          </div>
          <button className="mm-session-close" onClick={onClose} aria-label="Close threads">close</button>
        </div>
        <div className="mm-session-tools">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, preview, or id"
          />
          <button onClick={onRefresh} disabled={busy}>{busy ? 'syncing' : 'refresh'}</button>
          <button onClick={onClearCurrent}>clear current</button>
          <button className="danger" onClick={onDeleteAllSessions} disabled={busy || sessions.length === 0}>delete all threads</button>
        </div>
        <div className="mm-session-list">
          {filtered.length === 0 ? (
            <EmptyState>{sessions.length === 0 ? 'No threads yet — every conversation lands here.' : 'No matching threads.'}</EmptyState>
          ) : filtered.map((s) => {
            const active = s.id === currentId;
            const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : 'not dated';
            return (
              <article key={s.id} className={'mm-session-card' + (active ? ' active' : '') + (s.pinned ? ' pinned' : '')}>
                <button className="mm-session-main" onClick={() => onOpenSession(s.id)}>
                  <span className="mm-session-title">{s.pinned ? '★ ' : ''}{s.title || s.id}</span>
                  <span className="mm-session-preview">{s.preview || 'Empty thread'}</span>
                  <span className="mm-session-meta">{s.turns || 0} turns · {updated}</span>
                </button>
                <div className="mm-session-actions">
                  <button onClick={() => onTogglePin(s)}>{s.pinned ? 'unpin' : 'pin'}</button>
                  <button onClick={() => onRenameSession(s)}>rename</button>
                  <button onClick={() => onDuplicateSession(s)}>duplicate</button>
                  <button onClick={() => onExportSession(s)}>json</button>
                  <button onClick={() => onExportMarkdown(s)}>md</button>
                  <button className="danger" onClick={() => onDeleteSession(s)}>delete</button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function GoalView({ goalId, onClose }) {
  const [session, setSession] = React.useState(null);
  const [steps, setSteps] = React.useState([]);
  const [currentTokens, setCurrentTokens] = React.useState('');
  const [waitState, setWaitState] = React.useState(null);
  const [countdown, setCountdown] = React.useState('');
  const [expandedStep, setExpandedStep] = React.useState(null);

  React.useEffect(() => {
    fetch('/api/goal/' + goalId)
      .then(r => r.json())
      .then(s => { setSession(s); setSteps(s.steps || []); })
      .catch(() => {});

    const es = new EventSource('/api/goal/' + goalId + '/stream');
    es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.kind === 'goal-step-start') {
        setCurrentTokens('');
        setSteps(prev => {
          const next = [...prev];
          if (!next[evt.stepIndex]) {
            next.push({ prompt: evt.prompt, status: 'running' });
          } else {
            next[evt.stepIndex] = { ...next[evt.stepIndex], status: 'running' };
          }
          return next;
        });
      } else if (evt.kind === 'goal-token') {
        setCurrentTokens(prev => prev + evt.text);
      } else if (evt.kind === 'goal-step-done') {
        setSteps(prev => {
          const next = [...prev];
          if (next[evt.stepIndex]) next[evt.stepIndex] = { ...next[evt.stepIndex], result: evt.result, status: 'done' };
          return next;
        });
        setCurrentTokens('');
      } else if (evt.kind === 'goal-plan') {
        setSteps(prev => {
          const next = [...prev];
          if (!next[evt.stepIndex]) next.push({ prompt: evt.nextPrompt, status: 'pending' });
          return next;
        });
      } else if (evt.kind === 'quota-wait') {
        setWaitState({ resumeAt: evt.resumeAt, providers: evt.providers || [] });
      } else if (evt.kind === 'goal-done') {
        setWaitState(null);
        setCurrentTokens('');
        fetch('/api/goal/' + goalId).then(r => r.json()).then(s => { setSession(s); setSteps(s.steps || []); }).catch(() => {});
      } else if (evt.kind === 'goal-error') {
        setSession(prev => prev ? { ...prev, status: 'failed' } : { goalId, description: '?', steps: [], status: 'failed', createdAt: 0, updatedAt: 0 });
      } else if (evt.kind === 'goal-state' && evt.session) {
        setSession(evt.session);
        setSteps(evt.session.steps || []);
        if (evt.session.status === 'paused' && evt.session.pausedUntil) {
          setWaitState({ resumeAt: evt.session.pausedUntil, providers: [] });
        }
      }
    };
    return () => es.close();
  }, [goalId]);

  React.useEffect(() => {
    if (!waitState) { setCountdown(''); return; }
    const tick = () => {
      const ms = Math.max(0, waitState.resumeAt - Date.now());
      const s = Math.floor(ms / 1000);
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      setCountdown(hh + ':' + mm + ':' + ss);
      if (ms === 0) setWaitState(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [waitState]);

  const status = session?.status || 'running';
  const isDone = status === 'done';
  const isFailed = status === 'failed';

  return (
    <div className="mm-goal-view">
      <div className="mm-goal-header">
        <button className="mm-goal-back" onClick={onClose} title="Back to chat">← back</button>
        <div className="mm-goal-title">{session?.description || '…'}</div>
        <span className={'mm-goal-status-badge ' + status}>{status}</span>
      </div>

      {waitState && (
        <div className="mm-quota-wait-panel">
          <div className="mm-quota-wait-label">⏸ waiting for quota…</div>
          <div className="mm-quota-wait-timer tnum">{countdown}</div>
          {waitState.providers.length > 0 && (
            <div className="mm-quota-wait-providers">
              {waitState.providers.map(p => (
                <div key={p.id} className="mm-quota-wait-provider">
                  {p.id}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isDone && (
        <div className="mm-goal-done-banner">
          ✓ Goal complete — {steps.length} step{steps.length !== 1 ? 's' : ''}
          <button className="mm-goal-back-btn" onClick={onClose}>back to chat</button>
        </div>
      )}
      {isFailed && (
        <div className="mm-goal-error-banner">
          ✗ Goal failed
          <button className="mm-goal-back-btn" onClick={onClose}>back to chat</button>
        </div>
      )}

      <div className="mm-goal-steps">
        {steps.map((step, i) => (
          <div key={i} className={'mm-goal-step ' + (step.status || 'pending')}>
            <div className="mm-goal-step-header" onClick={() => setExpandedStep(expandedStep === i ? null : i)}>
              <span className="mm-goal-step-dot" />
              <span className="mm-goal-step-num">Step {i + 1}</span>
              <span className="mm-goal-step-prompt">{step.prompt}</span>
              {step.result && <span className="mm-goal-step-chevron">{expandedStep === i ? '▼' : '▶'}</span>}
            </div>
            {expandedStep === i && step.result && (
              <div className="mm-goal-step-body"><MarkdownProse text={step.result} /></div>
            )}
          </div>
        ))}
        {currentTokens && (
          <div className="mm-goal-step running">
            <div className="mm-goal-step-header">
              <span className="mm-goal-step-dot" />
              <span className="mm-goal-step-num">Step {steps.length + 1}</span>
              <span className="mm-goal-step-prompt">working…</span>
              <span className="mm-turn-caret" aria-hidden="true" />
            </div>
            <div className="mm-goal-step-body"><MarkdownProse text={currentTokens} /></div>
          </div>
        )}
        {!currentTokens && !isDone && !isFailed && !waitState && steps.length === 0 && (
          <div className="mm-goal-step pending">
            <div className="mm-goal-step-header">
              <span className="mm-goal-step-dot" />
              <span className="mm-goal-step-prompt">planning first step…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GoalEmptyView({ onClose }) {
  return (
    <div className="mm-goal-view">
      <div className="mm-goal-header">
        <button className="mm-goal-back" onClick={onClose}>back</button>
        <div className="mm-goal-title">Goals</div>
      </div>
      <div className="mm-goal-steps mm-goal-empty-wrap">
        <EmptyState>{'No goals running. Start one with /goal <what you want done>.'}</EmptyState>
      </div>
    </div>
  );
}

function CommandBar({
  settings,
  setSettings,
  blocked,
  onNewThread,
  onOpenThreads,
  onOpenFiles,
  onOpenGoals,
  onOpenSettings,
  onStartGoal,
  onOpenSession,
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const [recent, setRecent] = React.useState([]);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const onKey = (e) => {
      const key = String(e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'k') {
        if (blocked && !open) return;
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blocked, open]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('/api/sessions ' + res.status);
        const json = await res.json();
        if (!cancelled) setRecent((Array.isArray(json.sessions) ? json.sessions : []).slice(0, 8));
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const closeAndRun = React.useCallback((run) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    run?.();
  }, []);

  const baseActions = React.useMemo(() => [
    { id: 'new-thread', label: 'New thread', hint: 'Start with an empty conversation', run: onNewThread },
    { id: 'open-threads', label: 'Open threads', hint: 'Show saved conversations', run: onOpenThreads },
    { id: 'open-files', label: 'Open files', hint: 'Browse project files', run: onOpenFiles },
    { id: 'open-goals', label: 'Open goals', hint: 'Show active goal panel', run: onOpenGoals },
    { id: 'open-settings', label: 'Open settings', hint: 'Routing, models, appearance', run: onOpenSettings },
    {
      id: 'toggle-serious',
      label: settings.serious ? 'Disable serious mode' : 'Enable serious mode',
      hint: 'Toggle high thinking for Gemini calls',
      run: () => setSettings({ ...settings, serious: !settings.serious }),
    },
    {
      id: 'toggle-search',
      label: settings.search ? 'Disable search grounding' : 'Enable search grounding',
      hint: 'Toggle web search grounding',
      run: () => setSettings({ ...settings, search: !settings.search }),
    },
    {
      id: 'toggle-hybrid',
      label: settings.useLocal ? 'Disable hybrid local' : 'Enable hybrid local',
      hint: 'Toggle local Qwen reasoning/code routing',
      run: () => setSettings({ ...settings, useLocal: !settings.useLocal }),
    },
    ...ROUTING_OPTIONS.slice(0, 3).map((opt) => ({
      id: 'route-' + opt.value,
      label: 'Routing: ' + opt.label,
      hint: 'Switch composer routing mode',
      run: () => setSettings({ ...settings, forceRole: opt.forceRole, routingMode: opt.routingMode }),
    })),
    { id: 'start-goal', label: 'Start a goal...', hint: 'Prefill composer with /goal', run: onStartGoal },
  ], [onNewThread, onOpenThreads, onOpenFiles, onOpenGoals, onOpenSettings, onStartGoal, setSettings, settings]);

  const sessionActions = React.useMemo(() => recent.map((session) => ({
    id: 'session-' + session.id,
    label: session.title || session.id,
    hint: 'Open recent thread',
    run: () => onOpenSession(session.id),
  })), [recent, onOpenSession]);

  const actions = React.useMemo(() => {
    const all = [...baseActions, ...sessionActions];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((a) =>
      `${a.label} ${a.hint}`.toLowerCase().includes(q),
    );
  }, [baseActions, sessionActions, query]);

  React.useEffect(() => {
    if (active >= actions.length) setActive(Math.max(0, actions.length - 1));
  }, [active, actions.length]);

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => actions.length ? (i + 1) % actions.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => actions.length ? (i - 1 + actions.length) % actions.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (actions[active]) closeAndRun(actions[active].run);
    }
  };

  if (!open) return null;
  return (
    <div className="mm-command-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <div
        className="mm-command-bar"
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mm-command-input-wrap">
          <span>⌘K</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            placeholder="Search commands or threads"
          />
        </div>
        <div className="mm-command-list" role="listbox">
          {actions.length === 0 ? (
            <div className="mm-command-empty">No command found.</div>
          ) : actions.map((action, i) => (
            <button
              key={action.id}
              type="button"
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onClick={() => closeAndRun(action.run)}
              role="option"
              aria-selected={i === active}
            >
              <span className="mm-command-label">{action.label}</span>
              <span className="mm-command-hint">{action.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeroMindmap() {
  const ArtifactDialog = window.ArtifactReviewDialog;
  const initialStack = React.useMemo(loadPersistedStack, []);
  const [phase, setPhase] = React.useState(initialStack.length > 0 ? 'response' : 'idle');
  const [draft, setDraft] = React.useState('');
  const [attachments, setAttachments] = React.useState([]);
  const [currentPrompt, setCurrentPrompt] = React.useState('');
  const [responses, setResponses] = React.useState(initialStack);
  const [sessionId, setSessionId] = React.useState(() => loadSessionId());
  React.useEffect(() => {
    if (draft) return;
    const saved = loadSessionDraft(sessionId);
    if (saved) setDraft(saved);
  }, [sessionId]);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (draft && draft.length <= 8192) localStorage.setItem(DRAFT_LS_PREFIX + sessionId, draft);
        else if (!draft) clearSessionDraft(sessionId);
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, sessionId]);
  const stageRef = React.useRef(null);
  const [stageRect, setStageRect] = React.useState({ w: 0, h: 0 });
  // Live streaming state: while a turn is in flight, hold partial text +
  // the most recent progress event so the loading view + an in-progress
  // chat bubble can render in real time.
  // Shape: { prompt, partial, status: { phase: 'plan'|'role'|..., role?, framing?, plan? }, summarize?: { folded } }
  const [liveTurn, setLiveTurn] = React.useState(null);
  // Mobile sidebar drawer (the desktop sidebar is hidden by media query).
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  // Settings drawer — CLI-parity toggles (serious / search / force-role).
  // Persist on every change so refresh keeps the chosen mode.
  const [settings, setSettingsState] = React.useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const setSettings = React.useCallback((next) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);
  const activeSettingsCount = settingsActiveCount(settings);
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [goalOpen, setGoalOpen] = React.useState(false);
  const [activeGoalId, setActiveGoalId] = React.useState(null);
  const [fileDrawerPreload, setFileDrawerPreload] = React.useState(null);
  const [artifactReview, setArtifactReview] = React.useState(null);
  const [fileRefreshToken, setFileRefreshToken] = React.useState(0);
  const openArtifactFiles = React.useCallback(() => {
    setArtifactReview(null);
    setFilesOpen(true);
  }, []);
  const openFileForEdit = React.useCallback((path, content) => {
    setFileDrawerPreload({ path, content });
    setFilesOpen(true);
  }, []);
  const recordArtifactApply = React.useCallback((entryId, receipt) => {
    setResponses((current) => {
      const next = current.map((entry) => entry.id === entryId ? { ...entry, artifactReceipt: receipt } : entry);
      savePersistedStack(next);
      return next;
    });
    setFileRefreshToken((token) => token + 1);
  }, []);
  const undoArtifact = React.useCallback(async (entry) => {
    const receipt = entry?.artifactReceipt;
    const artifact = entry?.artifact;
    if (!receipt?.transactionId || !receipt?.undoToken || !artifact?.projectId || !artifact?.projectRevision) {
      throw new Error('This saved-file receipt is no longer available for undo.');
    }
    const response = await secureMutationFetch('/api/artifacts/transactions/' + encodeURIComponent(receipt.transactionId) + '/rollback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: artifact.projectId, projectRevision: artifact.projectRevision, undoToken: receipt.undoToken, confirm: true }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not undo the saved files.');
    setResponses((current) => {
      const next = current.map((item) => item.id === entry.id ? { ...item, artifactReceipt: { kind: 'undone', count: receipt.count } } : item);
      savePersistedStack(next);
      return next;
    });
    setFileRefreshToken((token) => token + 1);
  }, []);
  const [sessionList, setSessionList] = React.useState([]);
  const [sessionQuery, setSessionQuery] = React.useState('');
  const [sessionBusy, setSessionBusy] = React.useState(false);

  React.useEffect(() => {
    resetChrome();
    return resetChrome;
  }, []);

  const refreshSessions = React.useCallback(async () => {
    setSessionBusy(true);
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error('/api/sessions ' + res.status);
      const json = await res.json();
      setSessionList(Array.isArray(json.sessions) ? json.sessions : []);
    } catch {
      setSessionList([]);
    } finally {
      setSessionBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (sessionsOpen) refreshSessions();
  }, [sessionsOpen, refreshSessions]);

  // Surfaced when a stale `useLocal=true` setting from localStorage gets
  // auto-cleared on mount because the Ollama daemon isn't reachable on
  // the current device. The banner sits inside the response/idle phase
  // headers so the user notices before submitting a turn.
  const [hybridAutoOff, setHybridAutoOff] = React.useState(null);

  // On mount, if the persisted setting wants hybrid mode but the local
  // Ollama daemon isn't actually running on this device (e.g., the user
  // saved the setting on another machine and is now on one without local
  // models), turn the toggle back off so chat traffic stays on the cloud
  // chain. Without this, every reasoning/action-code turn would silently
  // fall through to the cloud fallback while the UI still suggested
  // local-first routing.
  React.useEffect(() => {
    if (!settings.useLocal) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ollama-health');
        if (cancelled) return;
        const health = res.ok ? await res.json() : { reachable: false };
        if (!health.reachable || (health.missing && health.missing.length > 0)) {
          setSettings({ ...settings, useLocal: false });
          setHybridAutoOff(
            !health.reachable
              ? `Hybrid local models disabled — Ollama daemon not detected on this device.`
              : `Hybrid local models disabled — missing models: ${health.missing.join(', ')}.`,
          );
          setTimeout(() => setHybridAutoOff(null), 6000);
        }
      } catch {
        if (!cancelled) {
          setSettings({ ...settings, useLocal: false });
          setHybridAutoOff('Hybrid local models disabled - could not verify Ollama on this device.');
          setTimeout(() => setHybridAutoOff(null), 6000);
        }
      }
    })();
    return () => { cancelled = true; };
    // Intentionally only run on mount; subsequent toggles go through the
    // SettingsDrawer's own gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const onTemplatePick = React.useCallback((key) => {
    const starter = TEMPLATE_DEFS[key]?.starter;
    if (!starter) return;
    setDraft(starter);
    requestAnimationFrame(() => {
      document.querySelector('.mm-composer textarea')?.focus();
    });
  }, []);
  const onStartGoalCommand = React.useCallback(() => {
    setDraft('/goal ');
    setPhase((p) => (p === 'loading' ? p : (responses.length > 0 ? 'response' : 'idle')));
    requestAnimationFrame(() => {
      document.querySelector('.mm-composer textarea')?.focus();
    });
  }, [responses.length]);

  // AbortController for the in-flight /api/chat-stream fetch. Held in a
  // ref so the stop button can reach it without re-rendering on creation.
  // We also track a boolean state `streaming` to drive UI (stop-button
  // visibility, composer disabled state).
  const streamAbortRef = React.useRef(null);
  const [streaming, setStreaming] = React.useState(false);
  const stopStream = React.useCallback(() => {
    const ac = streamAbortRef.current;
    if (ac) {
      try { ac.abort(); } catch {}
    }
    resetChrome();
  }, []);

  // Streaming chat submit. POSTs to /api/chat-stream and consumes the
  // server-sent events one at a time:
  //   - plan-start / plan / role-start / role-end / summarize-*: update
  //     the live status surface (LoadingView and the in-flight chat bubble)
  //   - token: append text to the partial reply so the bubble fills in
  //     real-time, like Claude/ChatGPT
  //   - done: finalize the turn into the responses array
  //   - error: append a placeholder error turn so the user sees the failure
  //
  // The fetch is bound to an AbortController so the stop button (see
  // `stopStream` above) can cancel mid-stream. On abort we keep whatever
  // partial text already arrived as a normal turn (so the user doesn't
  // lose work mid-thought) but suppress the error-string fallback —
  // an abort is intentional, not a failure.
  const submit = async (imagesArg = [], promptOverride = null, retryMeta = null) => {
    const retrying = typeof promptOverride === 'string';
    const q = (retrying ? promptOverride : draft).trim();
    const imgs = Array.isArray(imagesArg) ? imagesArg : [];
    const turnAttachments = retrying ? [] : attachments;
    if (!q && (!turnAttachments || turnAttachments.length === 0) && imgs.length === 0) return;

    // /goal <description> — start an autonomous goal loop instead of a chat turn
    if (!CHAT_ONLY && (q.startsWith('/goal ') || q === '/goal')) {
      const description = q.slice('/goal'.length).trim();
      if (!description) return;
      setDraft('');
      try {
        const res = await fetch('/api/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
        });
        if (res.ok) {
          const { goalId } = await res.json();
          setActiveGoalId(goalId);
          setGoalOpen(true);
        }
      } catch {}
      return;
    }

    // The user-visible prompt in chat is what they typed (or a placeholder
    // when attaching files with no extra prompt). The actual model input
    // includes the file contents prepended.
    const displayPrompt = q
      || (imgs.length ? `(${imgs.length} image${imgs.length > 1 ? 's' : ''})`
        : `(reviewing ${turnAttachments.length} attached file${turnAttachments.length > 1 ? 's' : ''})`);
    const fallbackPrompt = imgs.length
      ? 'Please look at the image(s) and respond.'
      : 'Please review the attached file(s) and respond.';
    const modelPrompt = composeMessageWithAttachments(q || fallbackPrompt, turnAttachments);
    const template = detectTemplate(displayPrompt);
    setCurrentPrompt(displayPrompt);
    if (!retrying) {
      setDraft('');
      clearSessionDraft(sessionId);
      setAttachments([]);
    }
    // Keep an existing transcript visible while the server routes the turn.
    setPhase(responses.length > 0 ? 'response' : 'loading');
    setLiveTurn({ prompt: displayPrompt, partial: '', status: { phase: 'plan-start' }, images: imgs });
    setStreaming(true);
    setBusyChrome('planning');

    let partial = '';
    let lastStatus = { phase: 'plan-start' };
    let summarizedTurns = 0;
    let toolActivity = [];
    let doneEvent = null;
    let errorMsg = null;
    let errorName = null;
    let aborted = false;
    // Data-layer agent-status accumulator. Mutated once per SSE status
    // event below (immune to React's setLiveTurn batching); a fresh
    // snapshot ships on liveTurn.agentState for LoadingView to render.
    let agentAcc = makeInitialAgentMap();

    const ac = new AbortController();
    streamAbortRef.current = ac;
    const reqStartMs = performance.now();

    try {
      // Build per-turn body — settings drawer translates to backend opts:
      //   serious  → thinking: "high"
      //   search   → useSearch: true
      //   forceRole (≠ 'auto') → forceRole: <role>
      const body = { sessionId, message: modelPrompt };
      if (settings.serious) body.thinking = 'high';
      if (settings.search) body.useSearch = true;
      if (settings.builder) body.builder = true;
      if (settings.forceRole && settings.forceRole !== 'auto') body.forceRole = settings.forceRole;
      body.useLocal = settings.useLocal === true;
      if (settings.routingMode && settings.routingMode !== 'smart') body.routingMode = settings.routingMode;
      if (imgs.length) body.images = imgs;
      const res = await fetch('/api/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/api/chat-stream ${res.status}`);

      // Parse SSE frames as bytes stream in. Each frame is `data: <json>\n\n`.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!frame.startsWith('data:')) continue;
          const json = frame.slice(5).trim();
          if (!json) continue;
          let evt;
          try { evt = JSON.parse(json); } catch { continue; }
          // Phase moves to 'response' the moment the first token arrives;
          // until then we stay in 'loading' so the LoadingView shows the
          // live agent status rectangles.
          if (evt.kind === 'token') {
            partial += evt.text;
            // First token → flip to response phase so the partial bubble shows.
            if (phaseRef.current === 'loading') {
              phaseRef.current = 'response';
              setPhase('response');
            }
            setLiveTurn((prev) => prev ? { ...prev, partial } : prev);
          } else if (evt.kind === 'plan-start' || evt.kind === 'plan'
                  || evt.kind === 'role-start' || evt.kind === 'role-end'
                  || evt.kind === 'summarize-start' || evt.kind === 'summarize-end') {
            lastStatus = { phase: evt.kind, ...evt };
            if (evt.kind === 'plan-start' || evt.kind === 'plan') setBusyChrome('planning');
            if (evt.kind === 'role-start') setBusyChrome(roleChromeLabel(evt.role));
            if (evt.kind === 'summarize-start') setBusyChrome('summarizing');
            if (evt.kind === 'summarize-end') summarizedTurns = evt.folded || 0;
            // Accumulate agent status HERE, synchronously, before React
            // batches the rapid setLiveTurn calls. agentAcc is a plain
            // local object so every event is applied even when a whole
            // burst of role-start/role-end frames arrives in one chunk.
            agentAcc = applyAgentEvent(agentAcc, lastStatus);
            const statusSnapshot = lastStatus;
            const agentSnapshot = agentAcc;
            setLiveTurn((prev) => prev ? { ...prev, status: statusSnapshot, agentState: agentSnapshot } : prev);
          } else if (evt.kind === 'tool') {
            toolActivity = [...toolActivity, { name: evt.name || 'tool', path: evt.path || '', ok: evt.ok !== false }];
            setBusyChrome('building');
            setLiveTurn((prev) => prev ? { ...prev, toolActivity } : prev);
          } else if (evt.kind === 'done') {
            doneEvent = evt;
          } else if (evt.kind === 'error') {
            errorMsg = evt.error || 'request failed';
            errorName = evt.errorName || 'Error';
          }
        }
      }
    } catch (e) {
      // Aborts come through as a DOMException with name === 'AbortError' in
      // most browsers; some implementations throw a TypeError on aborted
      // body reads. Either way, recognize "this was user-initiated cancel"
      // and don't surface as an error.
      if (e?.name === 'AbortError' || ac.signal.aborted) {
        aborted = true;
      } else {
        errorMsg = e.message || 'request failed';
        errorName = e.name || 'Error';
      }
    } finally {
      streamAbortRef.current = null;
      setStreaming(false);
      resetChrome();
    }

    // If the user aborted before ANY token landed, drop the turn entirely:
    // there's nothing meaningful to persist, and they've effectively said
    // "never mind." We still flip back to a safe phase below.
    if (aborted && !partial && !doneEvent) {
      setLiveTurn(null);
      setPhase(responses.length > 0 ? 'response' : 'idle');
      return;
    }

    // Finalize the turn into the responses array. On abort with partial
    // text we keep what arrived (no error string).
    const finalText = doneEvent?.reply || partial || '';
    const turnError = errorMsg ? {
      kind: errorName === 'AllProvidersExhaustedError' || errorName === 'NoProvidersConfiguredError' ? 'quota' : 'provider',
      message: errorMsg,
    } : null;
    const entry = {
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      prompt: displayPrompt,
      // In-memory only (stripped from localStorage by savePersistedStack's slim
      // projection); imageCount survives reload for the transcript indicator.
      images: imgs,
      imageCount: imgs.length,
      template,
      text: finalText.trim(),
      error: turnError,
      autoRetryAllowed: retryMeta?.automatic !== true,
      servedBy: doneEvent?.servedBy || [],
      plan: doneEvent?.plan || lastStatus?.plan?.kind || null,
      elapsedMs: Math.round(performance.now() - reqStartMs),
      tokenEstimate: doneEvent?.tokenEstimate || 0,
      tokenBudget: 100000,
      budgetPct: doneEvent?.budgetPct || 0,
      turns: doneEvent?.turns || 0,
      warning: doneEvent?.warning || null,
      artifact: doneEvent?.artifact || null,
      toolActivity,
      summarizedTurns: summarizedTurns || doneEvent?.summarizedTurns || 0,
      data: null,            // lazy-loaded by prefetchMindmapData
      dataLoading: false,
      dataError: false,
    };
    const next = [...responses, entry];
    setResponses(next);
    savePersistedStack(next);
    setLiveTurn(null);
    setPhase('response');
    if (!turnError && doneEvent?.turns === 1) {
      void generateSessionTitle(sessionId, displayPrompt, finalText);
    }

    // Mindmap enrichment remains available on demand. Do not spend a second
    // model call after every answer: it competes with the next interactive turn.
  };

  // Track phase in a ref so the SSE event handler can read the latest
  // value without React closure staleness on the in-flight call.
  const phaseRef = React.useRef(phase);
  React.useEffect(() => { phaseRef.current = phase; }, [phase]);

  // In-flight prefetches keyed by entry id. The burst handler awaits
  // the promise here when the user clicks BURST before categorization
  // has landed, so we never have to choose between a tiny wait and
  // showing made-up fallback data.
  const prefetchPromisesRef = React.useRef(new Map());

  // Categorize-prompt timeout. We wait up to 120s before declaring the
  // prefetch failed so the BarHandle's "structuring..." state doesn't
  // become permanent.
  const CATEGORIZE_TIMEOUT_MS = 120_000;

  // Categorize the entry's final markdown answer into the matching
  // template JSON, preserving every detail. Always routes to the
  // dedicated `mindmap-categorize` role — its chain starts with the
  // reserved gemma:3 slot (analogous to perception's gemini:3 reservation)
  // so chat/round-robin traffic on other roles can't drain the categorize
  // pool. Hybrid mode (qwen-coder) used to be the categorizer too, but
  // that meant qwen-coder got hit twice per round-robin turn: once for
  // the action-code parallel call and again for the categorize. Now it's
  // ALWAYS the reserved Gemma path → Cerebras → other Gemma slots.
  const prefetchMindmapData = React.useCallback(async (entry) => {
    if (!entry || entry.data) return entry?.data ?? null;
    const role = 'mindmap-categorize';
    setResponses((cur) => cur.map((e) =>
      e.id === entry.id ? { ...e, dataLoading: true, dataError: false } : e
    ));
    const prompt = comprehensiveCategorizePrompt(entry.template, entry.prompt, entry.text);
    let parsed = null;
    // AbortController + timeout — without this a stalled local Ollama
    // call (or any slow categorizer) would leave the prefetch promise
    // pending forever and the BarHandle stuck at "structuring…".
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CATEGORIZE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, role, useLocal: false }),
        signal: controller.signal,
      });
      if (res.ok) {
        const json = await res.json();
        // Robust extraction — categorize models (especially local ones
        // like qwen-coder, or reasoning models like deepseek-r1 that
        // emit <think>…</think> blocks) often wrap the JSON in prose,
        // markdown fences, or chain-of-thought tags. extractFirstJsonObject
        // strips the noise and pulls the first balanced {…}, then
        // JSON.parse runs against that candidate. If extraction returns
        // null, parsed stays null and the burst handler surfaces the
        // failure cleanly instead of rendering fictional fallback data.
        parsed = extractFirstJsonObject(String(json.reply || ''));
      }
    } catch {/* AbortError + network errors both fall through to null */}
    clearTimeout(timeoutId);
    // Only accept the prefetch result if its shape matches the
    // renderer's expectation. Malformed-but-parseable JSON (e.g.
    // `sections` as a string) would otherwise crash extractNodes.
    //
    // If the model-side categorizer fails, derive a deterministic
    // structure from the actual assistant reply. This is not fictional
    // fallback content: it splits the real markdown/text the user just
    // received, so the burst can still open when a provider is down,
    // quota-limited, or returns prose-wrapped garbage.
    const modelSafe = parsed && isValidMindmapData(entry.template, parsed) ? parsed : null;
    const derived = modelSafe ? null : deriveMindmapData(entry.template, entry.prompt, entry.text);
    const safe = modelSafe || (isValidMindmapData(entry.template, derived) ? derived : null);
    setResponses((cur) => {
      const next = cur.map((e) =>
        e.id === entry.id
          ? { ...e, dataLoading: false, data: safe, dataError: !safe }
          : e,
      );
      savePersistedStack(next);
      return next;
    });
    return safe;
  }, []);

  // Toast surfaced when burst is clicked but categorization failed
  // (no fictional fallback). Auto-clears after 3.5s.
  const [burstError, setBurstError] = React.useState(null);

  // Burst: orchestrator's final answer is categorized in the background
  // by the dedicated cloud/reserved mindmap-categorize role. When the user
  // clicks BURST:
  //   • If categorization is done and valid → play the catalyst transition.
  //   • If it's still running → await the prefetch promise; the BarHandle
  //     surfaces "structuring…" while the user sees a brief wait. No
  //     fictional fallback ever renders.
  //   • If categorization failed → surface a toast so the user knows
  //     to rephrase or retry, and stay on the chat phase.
  const expand = async () => {
    if (phase !== 'response') return;
    const newestEntry = responses[responses.length - 1];
    if (!newestEntry) return;

    // Wait for in-flight categorization rather than ever rendering
    // FALLBACK_DATA. The BarHandle's "structuring…" label keeps the
    // user informed during the wait.
    let data = newestEntry.data;
    if (!data && newestEntry.dataLoading) {
      const pending = prefetchPromisesRef.current.get(newestEntry.id);
      if (pending) {
        try { data = await pending; } catch { data = null; }
      }
    }

    // Categorisation is now explicitly requested by opening the mindmap,
    // rather than automatically consuming a model call after every reply.
    if (!data && !newestEntry.dataLoading) {
      const pending = prefetchMindmapData(newestEntry);
      prefetchPromisesRef.current.set(newestEntry.id, pending);
      try { data = await pending; } catch { data = null; }
    }

    if (!data || !isValidMindmapData(newestEntry.template, data)) {
      const derived = deriveMindmapData(newestEntry.template, newestEntry.prompt, newestEntry.text);
      if (isValidMindmapData(newestEntry.template, derived)) {
        data = derived;
        const next = responses.map((e) =>
          e.id === newestEntry.id
            ? { ...e, data, dataLoading: false, dataError: false }
            : e,
        );
        setResponses(next);
        savePersistedStack(next);
      }
    }

    if (!data || !isValidMindmapData(newestEntry.template, data)) {
      setBurstError(
        "couldn't structure this reply — try rephrasing or burst a later turn",
      );
      setTimeout(() => setBurstError(null), 3500);
      return;
    }

    if (prefersReducedMotion()) {
      setPhase('mindmap');
      return;
    }
    setPhase('collapsing');
    setTimeout(() => setPhase('mindmap'), COLLAPSE_TIMELINE.total);
  };
  // Reverse: implode the burst, then re-materialize the stack.
  const collapse = () => {
    if (phase !== 'mindmap') return;
    if (prefersReducedMotion()) {
      setPhase('response');
      return;
    }
    setPhase('imploding');
    setTimeout(() => setPhase('response'), IMPLODE_DURATION_MS);
  };
  const startEmptyThread = () => {
    clearSessionDraft(sessionId);
    const nextSession = resetSessionId();
    setSessionId(nextSession);
    setLiveTurn(null);
    setPhase('idle');
    setCurrentPrompt('');
    setDraft('');
    setAttachments([]);
    setResponses([]);
    clearPersistedStack();
    return nextSession;
  };
  const reset = () => {
    const oldSession = sessionId;
    startEmptyThread();
    fetch(`/api/sessions/${encodeURIComponent(oldSession)}/clear`, { method: 'POST' }).catch(() => {});
    refreshSessions();
  };

  const openSession = async (id) => {
    if (!id) return;
    stopStream();
    setSessionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('/api/sessions/' + id + ' ' + res.status);
      const json = await res.json();
      const next = responsesFromSessionHistory(id, json.history);
      setSessionId(id);
      persistSessionId(id);
      setResponses(next);
      savePersistedStack(next);
      setLiveTurn(null);
      setCurrentPrompt('');
      setDraft('');
      setAttachments([]);
      setPhase(next.length > 0 ? 'response' : 'idle');
      setSessionsOpen(false);
    } catch (e) {
      window.alert('Could not open that thread: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const renameSession = async (session) => {
    const title = window.prompt('Rename thread', session.title || '');
    if (title === null) return;
    setSessionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() || session.id }),
      });
      if (!res.ok) throw new Error('rename failed');
      await refreshSessions();
    } catch (e) {
      window.alert('Could not rename that thread: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const togglePinSession = async (session) => {
    setSessionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !session.pinned }),
      });
      if (!res.ok) throw new Error('pin failed');
      await refreshSessions();
    } catch (e) {
      window.alert('Could not update that thread: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const duplicateSessionUi = async (session) => {
    setSessionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/duplicate`, { method: 'POST' });
      if (!res.ok) throw new Error('duplicate failed');
      await refreshSessions();
    } catch (e) {
      window.alert('Could not duplicate that thread: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const deleteSessionUi = async (session) => {
    if (!window.confirm(`Delete thread "${session.title || session.id}"? This cannot be undone.`)) return;
    setSessionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      if (session.id === sessionId) {
        startEmptyThread();
      }
      await refreshSessions();
    } catch (e) {
      window.alert('Could not delete that thread: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const deleteAllSessionsUi = async () => {
    const count = sessionList.length;
    if (count === 0) return;
    if (!window.confirm(`Delete all ${count} saved thread${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
    stopStream();
    setSessionBusy(true);
    try {
      const res = await fetch('/api/sessions', { method: 'DELETE' });
      if (!res.ok) throw new Error('delete all failed');
      startEmptyThread();
      setSessionList([]);
      setSessionQuery('');
      setSessionsOpen(false);
    } catch (e) {
      window.alert('Could not delete all threads: ' + (e?.message || 'unknown error'));
    } finally {
      setSessionBusy(false);
    }
  };

  const exportSessionUi = (session) => {
    window.location.href = `/api/sessions/${encodeURIComponent(session.id)}/export`;
  };

  const exportSessionMarkdown = async (session) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`);
      if (!response.ok) throw new Error('export failed');
      const snapshot = await response.json();
      const lines = [`# ${session.title || session.id}`, ''];
      for (const part of snapshot.history || []) {
        if (part?.kind === 'user_text') {
          lines.push('## you', '', part.text || '');
          if (Array.isArray(part.images) && part.images.length) lines.push('', `*[${part.images.length} image(s) attached]*`);
          lines.push('');
        } else if (part?.kind === 'model_text') {
          lines.push('## orchestrator', '', part.text || '', '');
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeTitle = String(session.title || session.id).replace(/[^a-z0-9 _-]+/gi, '').trim().replace(/\s+/g, '-') || 'conversation';
      link.href = href; link.download = safeTitle + '.md'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (error) {
      window.alert('Could not export markdown: ' + (error?.message || 'unknown error'));
    }
  };

  const clearCurrentSession = () => {
    reset();
    setSessionsOpen(false);
  };

  // Soft recovery for PhaseErrorBoundary catches: keep the conversation
  // history (responses + sessionId) intact, but tear down any in-flight
  // turn state and return to a safe phase. If we have any persisted turns
  // we land on 'response'; otherwise we go to idle.
  const recoverFromError = React.useCallback(() => {
    setLiveTurn(null);
    setCurrentPrompt('');
    setPhase(responses.length > 0 ? 'response' : 'idle');
  }, [responses.length]);

  return (
    <div className="mm-root" data-phase={phase} data-theme={settings.theme || 'clay'}>
      <div className="mm-aurora" />
      <ConstellationOverlay key={settings.theme || 'clay'} />
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
        <div className="mm-nav-right">
          {CHAT_ONLY ? (
            <span className="mm-status local" title="File access, tools, saved sessions, and host settings are disabled">
              <i />CHAT ONLY
            </span>
          ) : (
          <>
          <SystemStatus useLocal={settings.useLocal} />
          <button
            className={'mm-nav-sessions' + (sessionsOpen ? ' open' : '')}
            onClick={() => setSessionsOpen(true)}
            title="Open saved threads"
            aria-label="Open saved threads"
          >
            threads
          </button>
          <button
            className={'mm-nav-files' + (filesOpen ? ' open' : '')}
            onClick={() => setFilesOpen(true)}
            title="Browse project files"
            aria-label="Browse project files"
          >
            files
          </button>
          <button
            className={'mm-nav-goals' + (goalOpen ? ' open' : '')}
            onClick={() => setGoalOpen(v => !v)}
            data-tip="Long-running tasks. Start one with /goal in chat."
            aria-label={goalOpen ? 'Close goals panel' : 'Open goals panel'}
          >
            goals
          </button>
          <button
            className={'mm-nav-settings' + (settingsOpen ? ' open' : '') + (activeSettingsCount > 0 ? ' active' : '')}
            onClick={() => setSettingsOpen(true)}
            title="Open settings (thinking depth, search, forced role)"
            aria-label="Open settings"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {activeSettingsCount > 0 && <span className="mm-nav-settings-badge">{activeSettingsCount}</span>}
          </button>
          </>
          )}
        </div>
      </nav>

      {!CHAT_ONLY && <>
      <Sidebar phase={phase} latestResponse={newest} open={sidebarOpen} useLocal={settings.useLocal} />
      {/* Mobile-only quota/stats toggle. Hidden via media query >880px. */}
      <button
        className={'mm-sidebar-toggle' + (sidebarOpen ? ' active' : '')}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? 'Hide quota panel' : 'Show quota / agents'}
      >
        {sidebarOpen ? 'close' : 'quota'}
      </button>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
      />

      <ConversationDrawer
        open={sessionsOpen}
        sessions={sessionList}
        query={sessionQuery}
        setQuery={setSessionQuery}
        currentId={sessionId}
        busy={sessionBusy}
        onClose={() => setSessionsOpen(false)}
        onRefresh={refreshSessions}
        onOpenSession={openSession}
        onRenameSession={renameSession}
        onTogglePin={togglePinSession}
        onDuplicateSession={duplicateSessionUi}
        onDeleteSession={deleteSessionUi}
        onDeleteAllSessions={deleteAllSessionsUi}
        onExportSession={exportSessionUi}
        onExportMarkdown={exportSessionMarkdown}
        onClearCurrent={clearCurrentSession}
      />
      <FileDrawer
        open={filesOpen}
        onClose={() => { setFilesOpen(false); setFileDrawerPreload(null); }}
        attachments={attachments}
        setAttachments={setAttachments}
        preload={fileDrawerPreload}
        onPreloadConsumed={() => setFileDrawerPreload(null)}
        refreshToken={fileRefreshToken}
      />
      {artifactReview && ArtifactDialog && (
        <ArtifactDialog
          artifact={artifactReview.artifact}
          onClose={() => setArtifactReview(null)}
          onApplied={(receipt) => recordArtifactApply(artifactReview.id, receipt)}
          onOpenFiles={openArtifactFiles}
          mutate={secureMutationFetch}
        />
      )}
      {goalOpen && activeGoalId && (
        <GoalView goalId={activeGoalId} onClose={() => setGoalOpen(false)} />
      )}
      {goalOpen && !activeGoalId && (
        <GoalEmptyView onClose={() => setGoalOpen(false)} />
      )}
      <CommandBar
        settings={settings}
        setSettings={setSettings}
        blocked={settingsOpen || sessionsOpen || filesOpen || goalOpen}
        onNewThread={startEmptyThread}
        onOpenThreads={() => setSessionsOpen(true)}
        onOpenFiles={() => setFilesOpen(true)}
        onOpenGoals={() => setGoalOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onStartGoal={onStartGoalCommand}
        onOpenSession={openSession}
      />
      </>}

      <div
        ref={stageRef}
        className="mm-stage"
        data-phase={phase}
        style={{ '--accent': accent }}
      >
        {/*
          Quota-warning strip. Renders nothing when every role is
          healthy; mounts a one-liner when any role drops below 10 %
          remaining, falls back, or the pool flips to serial mode.
          Lives inside the stage so it overlays content without
          taking layout space when hidden.
        */}
        {!CHAT_ONLY && <QuotaBanner phase={phase} useLocal={settings.useLocal} />}
        {hybridAutoOff ? (
          <div className="mm-quota-banner mm-quota-warn" role="status" aria-live="polite">
            <span className="mm-quota-banner-dot" />
            <span className="mm-quota-banner-msg">{hybridAutoOff}</span>
          </div>
        ) : null}
        {phase === 'idle' && (
          <PhaseErrorBoundary label="idle view" recoverLabel="reset" onRecover={reset}>
            <IdleView draft={draft} setDraft={setDraft} submit={submit} attachments={attachments} setAttachments={setAttachments} settings={settings} onTemplatePick={onTemplatePick} />
          </PhaseErrorBoundary>
        )}
        {phase === 'loading' && responses.length === 0 && (
          <PhaseErrorBoundary label="loading view" recoverLabel="← back to chat" onRecover={recoverFromError}>
            <LoadingView prompt={currentPrompt}
              liveStatus={liveTurn?.status}
              summarize={liveTurn?.summarize}
              agentState={liveTurn?.agentState}
            />
          </PhaseErrorBoundary>
        )}
        {(phase === 'response' || phase === 'loading' || phase === 'collapsing' || phase === 'imploding') && (
          <PhaseErrorBoundary label="chat" recoverLabel="reset thread" onRecover={reset}>
            <ResponseStackView
              draft={draft} setDraft={setDraft} submit={submit}
              responses={responses} expand={expand} reset={reset} phase={phase}
              liveTurn={liveTurn}
              attachments={attachments} setAttachments={setAttachments}
              burstError={burstError}
              onApplyEdit={CHAT_ONLY ? null : openFileForEdit}
              onReviewArtifact={CHAT_ONLY ? null : setArtifactReview}
              onUndoArtifact={CHAT_ONLY ? null : undoArtifact}
              onOpenArtifactFiles={CHAT_ONLY ? null : openArtifactFiles}
              onRetryTurn={(entry, automatic) => submit(entry.images || [], entry.prompt, { automatic })}
              retryDisabled={streaming}
              settings={settings}
            />
          </PhaseErrorBoundary>
        )}
        {phase === 'collapsing' && (
          <PhaseErrorBoundary label="catalyst" recoverLabel="← back to chat" onRecover={recoverFromError}>
            <CatalystOverlay
              newest={newest}
              stageRect={stageRect}
              slideDistance={stageRect.h ? stageRect.h * 0.36 : 200}
            />
          </PhaseErrorBoundary>
        )}
        {phase === 'mindmap' && (
          <PhaseErrorBoundary label="mindmap" recoverLabel="← back to chat" onRecover={collapse}>
            <OrbitalMindmap
              responses={responses}
              collapse={collapse} reset={reset} phase={phase}
              draft={draft} setDraft={setDraft} submit={submit}
              attachments={attachments} setAttachments={setAttachments}
              settings={settings}
            />
          </PhaseErrorBoundary>
        )}
        {/*
          Floating stop button — only mounts while a /api/chat-stream
          turn is in flight. Calls AbortController.abort(); the submit
          handler's catch block recognizes the abort, keeps any partial
          text already streamed, and returns to a safe phase. Lives
          inside .mm-stage so it sits above LoadingView and the chat
          composer alike without either needing to know about it.
        */}
        {streaming && (
          <button
            className="mm-stop-stream"
            onClick={stopStream}
            title="Stop generating (saves quota on bad turns)"
            aria-label="Stop generating"
          >
            <span className="mm-stop-glyph" aria-hidden="true" />
            <span className="mm-stop-label">stop</span>
          </button>
        )}
      </div>
    </div>
  );
}

window.HeroMindmap = HeroMindmap;
