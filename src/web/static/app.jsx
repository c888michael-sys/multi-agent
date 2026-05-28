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
//   • Live web search          → adds `useSearch: true` so the perception
//     primary uses Google Search grounding (CLI: --search).
//   • Force role               → bypasses smart routing for the next turn
//     and pins the call to a specific role's chain (CLI: --role=<name>).
// Settings persist to localStorage; HeroMindmap reads them per submit and
// includes them in the /api/chat-stream body. The chip in the nav reflects
// the *number of non-default* knobs so the user can tell at a glance
// whether anything is currently in effect.
function SettingsDrawer({ open, onClose, settings, onChange }) {
  const drawerRef = React.useRef(null);
  // Hybrid-mode health gate. When the user toggles 'Hybrid local models'
  // ON we ping /api/ollama-health; if the daemon isn't reachable OR the
  // two required models aren't pulled, we refuse the toggle and surface
  // a clear reason. This prevents the silent-fail state where chat turns
  // pretend to work in hybrid mode but every local hop falls through to
  // the cloud fallback, which is confusing.
  const [hybridError, setHybridError] = React.useState(null);
  const [hybridChecking, setHybridChecking] = React.useState(false);
  // Close on Escape so the drawer doesn't trap focus.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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

  return (
    <>
      <div
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
                <span className="mm-settings-hint">route reasoning → DeepSeek-R1 32B and action-code → Qwen 2.5 Coder on your local Ollama daemon. Other roles unchanged. (CLI: <code>--local</code>)</span>
                {hybridError ? (
                  <span className="mm-settings-error" role="alert">{hybridError}</span>
                ) : null}
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
                <span className="mm-settings-name">Live web search</span>
                <span className="mm-settings-hint">Google Search grounding on every call that supports it (CLI: <code>--search</code>)</span>
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
              <code>auto</code>: orchestrator picks direct/single/parallel per turn. <code>round-robin</code>: every turn fans out to perception + reasoning + coder + structural, then synthesizes (default). Pick a specific role to pin every turn to that role's chain (CLI: <code>--role=&lt;name&gt;</code>).
            </span>
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
  if (s.search) n++;
  if (s.useLocal) n++;
  // Routing is now a single merged knob (routingMode + forceRole). The
  // default is the round-robin meta-entry, so any other dropdown value
  // counts as a non-default knob.
  if (routingValueFromSettings(s) !== 'round-robin') n++;
  return n;
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
              title={role.providerId ? `${role.providerId}${role.fallback ? ' (fallback)' : ''}` : 'No provider registered'}
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
                ? `${role.providerId}${role.fallback ? ' (fallback)' : ''}${localRow ? ' — local Ollama daemon' : ''}`
                : 'No provider registered'}
            >
              <div className="mm-rate-head">
                <span className="mm-rate-label">{a.name.toLowerCase()}</span>
                {isCooling
                  ? <span className="mm-rate-cooling">cooling {formatCountdown(liveCooldownMs)}</span>
                  : <span className="mm-rate-provider">{role?.providerId || 'n/a'}{role?.fallback && !localRow ? ' ⤳' : ''}</span>}
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
                  <span className="mm-rate-gauge-num">
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
                  <span className="mm-rate-gauge-num">
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

// Render an attached file's content as a fenced block the model can read.
// Uses the file extension as the fence language hint when present.
function fenceForAttachment(att) {
  const dot = att.name.lastIndexOf('.');
  const ext = dot > 0 ? att.name.slice(dot + 1).toLowerCase() : '';
  // Pick three backticks but bump count if the file itself contains them.
  let fence = '```';
  while (att.text.includes(fence)) fence += '`';
  return `${fence}${ext}\n${att.text}\n${fence}`;
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

// ─── Composer (used in idle + response phases) ─────────────
function Composer({ value, onChange, onSubmit, autoFocus, disabled, attachments, setAttachments }) {
  const ref = React.useRef(null);
  const fileRef = React.useRef(null);
  const [attachError, setAttachError] = React.useState(null);
  const canAttach = typeof setAttachments === 'function';
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
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-picking the same filename later
    if (!files.length || !canAttach) return;
    const current = attachments || [];
    const accepted = [...current];
    let total = accepted.reduce((acc, a) => acc + a.text.length, 0);
    const errors = [];
    for (const f of files) {
      if (total + f.size > ATTACH_TOTAL_MAX_BYTES) {
        errors.push(`${f.name}: would exceed total ${ATTACH_TOTAL_MAX_BYTES / 1024} KB cap`);
        continue;
      }
      try {
        const att = await readFileAsText(f);
        accepted.push(att);
        total += att.text.length;
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

  const hasContent = !!value.trim() || (attachments && attachments.length > 0);
  return (
    <div className="mm-composer">
      <div className="mm-composer-in">
        <div className="mm-composer-prefix">
          <span>$ lattice ~/ orchestrate</span>
          <span className="live">{disabled ? 'routing' : 'live'}</span>
        </div>
        {canAttach && attachments && attachments.length > 0 && (
          <div className="mm-attach-chips">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="mm-attach-chip" title={`${a.name} · ${(a.text.length / 1024).toFixed(1)} KB`}>
                <span className="mm-attach-name">{a.name}</span>
                <span className="mm-attach-size">{(a.text.length / 1024).toFixed(1)} KB</span>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
          placeholder="› describe what you need — research, code, comparison, plan…"
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <div className="mm-composer-bar">
          <span className="mm-model"><i />smart routing · 5 visible roles</span>
          <div className="mm-composer-actions">
            {canAttach && (
              <>
                <input
                  type="file"
                  ref={fileRef}
                  multiple
                  style={{ display: 'none' }}
                  onChange={onPickFiles}
                  accept=".txt,.md,.markdown,.json,.yaml,.yml,.csv,.tsv,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cc,.cpp,.h,.hpp,.sh,.bash,.zsh,.ps1,.toml,.ini,.cfg,.conf,.log,.sql,.gql,.graphql,.proto,text/*,application/json"
                />
                <button
                  className="mm-attach-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={disabled}
                  title="Attach text files"
                  aria-label="Attach file"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                    <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L13.5 4.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            <button className="mm-send" onClick={onSubmit} disabled={disabled || !hasContent}>
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
// One turn in the chat-style scroll view. User prompt on top
// (right-aligned), AI response below (left-aligned). The AI bubble
// renders the orchestrator's RAW prose answer (no category split —
// that's the mindmap's job). Newest gets a subtle accent ring.
function ChatTurn({ entry, accent, isNewest }) {
  const tpl = TEMPLATE_DEFS[entry.template];
  const streaming = !!entry.streaming;
  // Status pill: while streaming, surface the live phase (plan / role /
  // synth) so the user reads what's happening. Once the turn lands, fall
  // back to servedBy or the template label.
  const liveLabel = streaming
    ? statusLabel(entry.status)
    : (entry.servedBy?.length ? entry.servedBy.join(' + ') : (tpl?.label || entry.template));
  return (
    <div
      className={'mm-turn' + (isNewest ? ' newest' : '') + (streaming ? ' streaming' : '')}
      style={{ '--accent': accent }}
    >
      <div className="mm-turn-user">
        <span className="mm-turn-role">you</span>
        <div className="mm-turn-user-bubble">{entry.prompt}</div>
      </div>
      <div className="mm-turn-ai">
        <span className="mm-turn-role">
          orchestrator
          <span className={'mm-turn-pill' + (streaming ? ' live' : '')}>
            <span className="mm-template-dot" />
            {liveLabel}
          </span>
        </span>
        <div className="mm-turn-ai-bubble">
          {entry.text
            ? <MarkdownProse text={entry.text} />
            : <span className="mm-turn-empty">{streaming ? 'preparing reply…' : ''}</span>}
          {streaming && <span className="mm-turn-caret" aria-hidden="true" />}
          <div className="mm-turn-foot">
            <CopyButton getText={() => entry.text || ''} />
          </div>
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
    if (status.phase === 'synthesis') return 'synthesizing…';
    if (status.phase === 'direct') return 'orchestrator answering…';
    return `${status.role || 'agent'}: thinking…`;
  }
  if (ph === 'role-end') return `${status.role || 'agent'}: done`;
  if (ph === 'summarize-start') return 'summarizing older turns…';
  if (ph === 'summarize-end') return `summarized ${status.folded || 0} turn(s)`;
  return 'thinking…';
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
      <div className="mm-catalyst-field">
        <span />
        <span />
        <span />
      </div>
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

function IdleView({ draft, setDraft, submit, attachments, setAttachments }) {
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
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus attachments={attachments} setAttachments={setAttachments} />
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

// LoadingView — reflects the REAL live status from the streaming
// ChatSession run when available. Falls back to a gentle ambient
// cycle when no live data exists (e.g. legacy non-streaming code path).
// Each agent row's state is driven by the SSE events:
//   plan-start          → orchestrator is "deciding…"
//   role-start single   → that specialist is "thinking…"
//   role-start parallel → multiple specialists "thinking…" concurrently
//   role-start synth    → orchestrator is "synthesizing…"
//   role-end            → marks the agent as "done"
function LoadingView({ prompt, liveStatus, summarize }) {
  // Map the latest status event to a per-agent state map.
  const agentState = React.useMemo(() => {
    const map = Object.fromEntries(MM_AGENTS.map((a) => [a.id, { state: 'queued', label: 'queued' }]));
    if (!liveStatus) return map;
    const { phase, role, kind, ok, plan } = liveStatus;
    // Prefer kind (outer event type: role-start / role-end / plan-start / plan)
    // over phase (inner sub-phase: single / synthesis / direct / parallel).
    // The /api/chat-stream client merges events as `{phase: evt.kind, ...evt}`,
    // which means evt.phase ("single", "synthesis", …) clobbers the outer
    // phase= evt.kind we just wrote. Without this inversion every role-start
    // resolved to its inner phase string ("single"), missed every branch in
    // the switch below, and the agent state map stayed in its initial
    // plan-start state — so only `orchestration` ever showed as working.
    const ph = kind || phase;
    if (ph === 'plan-start') {
      // Orchestrator is choosing roles
      map['orchestration'] = { state: 'engaged', label: 'planning…' };
    } else if (ph === 'plan') {
      // Plan settled — annotate which specialists will run
      map['orchestration'] = { state: 'engaged', label: `plan: ${plan?.kind || '?'}` };
      if (plan?.kind === 'single' && plan.role) {
        map[plan.role] = { state: 'queued', label: 'queued' };
      } else if (plan?.kind === 'parallel' && Array.isArray(plan.tasks)) {
        for (const t of plan.tasks) {
          if (map[t.role]) map[t.role] = { state: 'queued', label: 'queued' };
        }
      }
    } else if (ph === 'role-start' && role) {
      if (map[role]) {
        if (liveStatus.phase === 'synthesis') {
          map[role] = { state: 'engaged', label: 'synthesizing…' };
        } else if (liveStatus.phase === 'direct') {
          map[role] = { state: 'engaged', label: 'answering directly…' };
        } else {
          map[role] = { state: 'engaged', label: 'thinking…' };
        }
      }
    } else if (ph === 'role-end' && role) {
      if (map[role]) map[role] = { state: ok === false ? 'failed' : 'done', label: ok === false ? 'failed' : '✓ done' };
    }
    return map;
  }, [liveStatus]);

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
          const s = agentState[a.id] || { state: 'queued', label: 'queued' };
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
  attachments, setAttachments, burstError,
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
  // Trigger when newest id changes (new completed turn) OR when a live
  // turn is streaming so the partial bubble keeps sticking to the bottom
  // as tokens arrive. The auto-scroll only happens if the user is
  // already near the bottom — otherwise they may be reading older turns.
  const partialLen = liveTurn?.partial?.length || 0;
  React.useEffect(() => {
    const list = listRef.current;
    const bottom = bottomRef.current;
    if (!list || !bottom) return;
    const idChanged = lastIdRef.current !== newest?.id;
    if (!idChanged && !imploding && !liveTurn) return;
    lastIdRef.current = newest?.id;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    if (!idChanged && !imploding && !nearBottom) return;
    const doScroll = () => {
      try {
        bottom.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } catch {
        list.scrollTop = list.scrollHeight;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(doScroll, 80)));
  }, [newest?.id, imploding, responses.length, partialLen, liveTurn?.status?.kind]);

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
              isNewest={i === responses.length - 1 && !liveTurn}
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
              }}
              accent={accent}
              isNewest={true}
            />
          )}
          {/* Scroll anchor — scrollIntoView target so smooth-scroll
              survives heavy-render newest turns. */}
          <div ref={bottomRef} className="mm-chat-anchor" aria-hidden="true" />
        </div>
        <div className="mm-chat-composer">
          <Composer value={draft} onChange={setDraft} onSubmit={submit} attachments={attachments} setAttachments={setAttachments} />
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
function FocusedNodeView({ node, accent, onBack, draft, setDraft, submit, attachments, setAttachments }) {
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
        <Composer value={draft} onChange={setDraft} onSubmit={submit} autoFocus attachments={attachments} setAttachments={setAttachments} />
      </div>
    </div>
  );
}

function OrbitalMindmap({
  responses, collapse, reset, phase,
  draft, setDraft, submit,
  attachments, setAttachments,
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
          <Composer value={draft} onChange={setDraft} onSubmit={submit} attachments={attachments} setAttachments={setAttachments} />
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

// Persistent user-tunable knobs that mirror CLI flags one-for-one:
//   serious  → thinking: "high"  (Gemini extended reasoning on every call)
//   search   → useSearch: true   (Google Search grounding on the perception primary)
//   role     → forceRole (one of RoleName) | 'auto' (let smart-routing decide)
//   routingMode → 'smart' | 'round-robin' (default round-robin)
// All knobs persist to localStorage so refresh / new tab keeps the user's
// chosen mode. The settings drawer surfaces routingMode and forceRole as
// a single merged dropdown (see ROUTING_OPTIONS) — internally they remain
// independent so the wire format with the server is unchanged.
const DEFAULT_SETTINGS = { serious: false, search: false, forceRole: 'auto', useLocal: false, routingMode: 'round-robin' };

// Merged dropdown that replaces the prior separate Force-role select + a
// Smart-vs-RoundRobin radio group. Two "meta" entries on top combine the
// routingMode field with forceRole='auto'; the rest pin a specific role
// and use smart routing under the hood. round-robin is the default —
// users typically want the multi-agent feel and can opt into a single
// role or pure smart routing per session.
const ROUTING_OPTIONS = [
  { value: 'auto',              label: 'auto (smart routing)',         routingMode: 'smart',       forceRole: 'auto' },
  { value: 'round-robin',       label: 'round-robin (default)',        routingMode: 'round-robin', forceRole: 'auto' },
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
  if (s.routingMode === 'round-robin') return 'round-robin';
  if (s.routingMode === 'smart' && (!s.forceRole || s.forceRole === 'auto')) return 'auto';
  if (s.forceRole && s.forceRole !== 'auto') return s.forceRole;
  return 'round-robin';
}

const VALID_FORCE_ROLES = new Set(['auto', 'orchestration', 'perception', 'reasoning', 'action-code', 'action-structural', 'action-repetitive']);
const VALID_ROUTING_MODES = new Set(['smart', 'round-robin']);

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      serious: typeof parsed.serious === 'boolean' ? parsed.serious : false,
      search:  typeof parsed.search  === 'boolean' ? parsed.search  : false,
      forceRole: VALID_FORCE_ROLES.has(parsed.forceRole) ? parsed.forceRole : 'auto',
      useLocal: typeof parsed.useLocal === 'boolean' ? parsed.useLocal : false,
      routingMode: VALID_ROUTING_MODES.has(parsed.routingMode) ? parsed.routingMode : DEFAULT_SETTINGS.routingMode,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
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

function HeroMindmap() {
  const initialStack = React.useMemo(loadPersistedStack, []);
  const [phase, setPhase] = React.useState(initialStack.length > 0 ? 'response' : 'idle');
  const [draft, setDraft] = React.useState('');
  const [attachments, setAttachments] = React.useState([]);
  const [currentPrompt, setCurrentPrompt] = React.useState('');
  const [responses, setResponses] = React.useState(initialStack);
  const [sessionId, setSessionId] = React.useState(() => loadSessionId());
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
      } catch {/* silent — leave whatever the user picked */}
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
  const submit = async () => {
    const q = draft.trim();
    if (!q && (!attachments || attachments.length === 0)) return;
    // The user-visible prompt in chat is what they typed (or a placeholder
    // when attaching files with no extra prompt). The actual model input
    // includes the file contents prepended.
    const displayPrompt = q || `(reviewing ${attachments.length} attached file${attachments.length > 1 ? 's' : ''})`;
    const modelPrompt = composeMessageWithAttachments(q || 'Please review the attached file(s) and respond.', attachments);
    const template = detectTemplate(displayPrompt);
    setCurrentPrompt(displayPrompt);
    setDraft('');
    setAttachments([]);
    setPhase('loading');
    setLiveTurn({ prompt: displayPrompt, partial: '', status: { phase: 'plan-start' } });
    setStreaming(true);

    let partial = '';
    let lastStatus = { phase: 'plan-start' };
    let summarizedTurns = 0;
    let doneEvent = null;
    let errorMsg = null;
    let aborted = false;

    const ac = new AbortController();
    streamAbortRef.current = ac;

    try {
      // Build per-turn body — settings drawer translates to backend opts:
      //   serious  → thinking: "high"
      //   search   → useSearch: true
      //   forceRole (≠ 'auto') → forceRole: <role>
      const body = { sessionId, message: modelPrompt };
      if (settings.serious) body.thinking = 'high';
      if (settings.search) body.useSearch = true;
      if (settings.forceRole && settings.forceRole !== 'auto') body.forceRole = settings.forceRole;
      if (settings.useLocal) body.useLocal = true;
      if (settings.routingMode && settings.routingMode !== 'smart') body.routingMode = settings.routingMode;
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
            if (evt.kind === 'summarize-end') summarizedTurns = evt.folded || 0;
            setLiveTurn((prev) => prev ? { ...prev, status: lastStatus } : prev);
          } else if (evt.kind === 'done') {
            doneEvent = evt;
          } else if (evt.kind === 'error') {
            errorMsg = evt.error || 'request failed';
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
      }
    } finally {
      streamAbortRef.current = null;
      setStreaming(false);
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
    const finalText = doneEvent?.reply || partial || (errorMsg ? `(error: ${errorMsg})` : '');
    const entry = {
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      prompt: displayPrompt,
      template,
      text: finalText.trim(),
      servedBy: doneEvent?.servedBy || [],
      plan: doneEvent?.plan || lastStatus?.plan?.kind || null,
      tokenEstimate: doneEvent?.tokenEstimate || 0,
      tokenBudget: 100000,
      budgetPct: doneEvent?.budgetPct || 0,
      turns: doneEvent?.turns || 0,
      warning: doneEvent?.warning || null,
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

    // Background mindmap pre-fetch — categorize the final answer into
    // the template's structured shape with NO detail omitted. Stored
    // on the entry's `data` field so the burst transition is instant.
    // Route to qwen-coder (local) when hybrid mode is on, cerebras
    // otherwise — see prefetchMindmapData. We keep the promise in
    // prefetchPromisesRef so the burst handler can await it if the
    // user clicks before categorization lands.
    if (entry.text && !entry.text.startsWith('(error')) {
      const p = prefetchMindmapData(entry);
      prefetchPromisesRef.current.set(entry.id, p);
      p.catch(() => {});
    }
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

  // Categorize-prompt timeout. Local Ollama models (qwen-coder in
  // hybrid mode) can take 30-60s on modest hardware before they emit
  // anything; we wait up to 120s before declaring the prefetch failed
  // so the BarHandle's "structuring…" state doesn't become permanent.
  const CATEGORIZE_TIMEOUT_MS = 120_000;

  // Categorize the entry's final markdown answer into the matching
  // template JSON, preserving every detail. Routes to qwen-coder
  // (action-code role, local) when hybrid mode is on, otherwise to
  // Cerebras (action-repetitive role, 1M tok/day budget). Updates
  // state in-place and returns the validated structured data — the
  // burst handler awaits this when needed.
  const prefetchMindmapData = React.useCallback(async (entry) => {
    if (!entry || entry.data) return entry?.data ?? null;
    const role = settings.useLocal ? 'action-code' : 'action-repetitive';
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
        body: JSON.stringify({ prompt, role, useLocal: settings.useLocal }),
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
    const safe = parsed && isValidMindmapData(entry.template, parsed) ? parsed : null;
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
  }, [settings.useLocal]);

  // Toast surfaced when burst is clicked but categorization failed
  // (no fictional fallback). Auto-clears after 3.5s.
  const [burstError, setBurstError] = React.useState(null);

  // Burst: orchestrator's final answer is categorized in the background
  // by qwen-coder (hybrid mode) or Cerebras (cloud mode). When the user
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

    if (!data || !isValidMindmapData(newestEntry.template, data)) {
      setBurstError(
        "couldn't structure this reply — try rephrasing or burst a later turn",
      );
      setTimeout(() => setBurstError(null), 3500);
      return;
    }

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
    const oldSession = sessionId;
    const nextSession = resetSessionId();
    setSessionId(nextSession);
    fetch(`/api/sessions/${encodeURIComponent(oldSession)}/clear`, { method: 'POST' }).catch(() => {});
    setPhase('idle');
    setCurrentPrompt('');
    setDraft('');
    setAttachments([]);
    setResponses([]);
    clearPersistedStack();
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
        <div className="mm-nav-right">
          <div className="mm-status"><i />5/5 AGENTS ONLINE</div>
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
        </div>
      </nav>

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
        <QuotaBanner phase={phase} useLocal={settings.useLocal} />
        {hybridAutoOff ? (
          <div className="mm-quota-banner mm-quota-warn" role="status" aria-live="polite">
            <span className="mm-quota-banner-dot" />
            <span className="mm-quota-banner-msg">{hybridAutoOff}</span>
          </div>
        ) : null}
        {phase === 'idle' && (
          <PhaseErrorBoundary label="idle view" recoverLabel="reset" onRecover={reset}>
            <IdleView draft={draft} setDraft={setDraft} submit={submit} attachments={attachments} setAttachments={setAttachments} />
          </PhaseErrorBoundary>
        )}
        {phase === 'loading' && (
          <PhaseErrorBoundary label="loading view" recoverLabel="← back to chat" onRecover={recoverFromError}>
            <LoadingView prompt={currentPrompt}
              liveStatus={liveTurn?.status}
              summarize={liveTurn?.summarize}
            />
          </PhaseErrorBoundary>
        )}
        {(phase === 'response' || phase === 'collapsing' || phase === 'imploding') && (
          <PhaseErrorBoundary label="chat" recoverLabel="reset thread" onRecover={reset}>
            <ResponseStackView
              draft={draft} setDraft={setDraft} submit={submit}
              responses={responses} expand={expand} reset={reset} phase={phase}
              liveTurn={liveTurn}
              attachments={attachments} setAttachments={setAttachments}
              burstError={burstError}
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
