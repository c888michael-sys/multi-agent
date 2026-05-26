import type { Router } from "./router.js";

export interface ConservationConfig {
  /**
   * When aggregate remaining quota drops below this percent, the router
   * switches from round-robin (multi-agent friendly) to serial (one
   * provider at a time — drain one, keep the rest in reserve).
   *
   * Tune this once you know real Gemini free-tier limits. Default 25%.
   */
  thresholdPct?: number;
  /**
   * When all providers recover above this percent, switch back to
   * round-robin. Hysteresis: must be higher than thresholdPct to avoid
   * flapping. Default 50%.
   */
  releasePct?: number;
}

export interface ConservationStatus {
  mode: "round-robin" | "serial";
  aggregateRemainingPct: number | null;
  providersWithBudget: number;
  providersTotal: number;
}

/**
 * Policy layer that watches Router's usage snapshot and flips its mode
 * between round-robin and serial based on aggregate remaining quota.
 *
 * Call `tick()` from your own loop (or after each completion) — there is
 * no internal timer, on purpose. Tests and callers stay in control.
 */
export class ConservationPolicy {
  private readonly router: Router;
  private readonly thresholdPct: number;
  private readonly releasePct: number;

  constructor(router: Router, config?: ConservationConfig) {
    this.router = router;
    this.thresholdPct = config?.thresholdPct ?? 25;
    this.releasePct = config?.releasePct ?? 50;
    if (this.releasePct <= this.thresholdPct) {
      throw new Error("releasePct must be greater than thresholdPct (hysteresis)");
    }
  }

  /** Recomputes mode based on current usage. Returns the new status. */
  tick(): ConservationStatus {
    const snap = this.router.snapshot();
    const withBudget = snap.filter((s) => s.remainingPct !== undefined);

    // No budget info → can't make a decision. Leave mode untouched.
    if (withBudget.length === 0) {
      return {
        mode: this.router.getMode(),
        aggregateRemainingPct: null,
        providersWithBudget: 0,
        providersTotal: snap.length,
      };
    }

    const aggregate =
      withBudget.reduce((sum, s) => sum + (s.remainingPct ?? 0), 0) / withBudget.length;

    const current = this.router.getMode();
    let next = current;
    if (current === "round-robin" && aggregate < this.thresholdPct) {
      next = "serial";
    } else if (current === "serial" && aggregate >= this.releasePct) {
      next = "round-robin";
    }
    if (next !== current) this.router.setMode(next);

    return {
      mode: next,
      aggregateRemainingPct: aggregate,
      providersWithBudget: withBudget.length,
      providersTotal: snap.length,
    };
  }
}

/**
 * Convenience helper: build a ConservationPolicy and wire it to auto-tick
 * after every router call. The returned policy lets callers still invoke
 * .tick() manually (e.g., from tests). Pass the SAME Router instance you
 * want the policy to govern.
 *
 * Use this in CLI / app code paths where you want conservation mode to
 * adapt in real time without an explicit polling loop.
 */
export function attachConservationPolicy(
  router: Router,
  config?: ConservationConfig,
): ConservationPolicy {
  const policy = new ConservationPolicy(router, config);
  router.setOnAfterCall(() => policy.tick());
  return policy;
}

/**
 * Pretty-print snapshot for console display. Per-provider line:
 *
 *   gemini:1  RPM 2/5  RPD 8/20 (~60% left) [est.]  rejected: 0   [cooling 0:42]
 *
 *   - RPM is the rolling-60s window (recovers in <1 min)
 *   - RPD is success-count vs estimated daily budget (resets at UTC midnight)
 *   - `rejected` is the cumulative count of rate-limited attempts today
 *   - cooldown countdown is shown only when active
 */
export function formatUsageReport(router: Router): string {
  const snap = router.snapshot();
  const now = Date.now();
  const utc = new Date(now).toISOString().slice(0, 10);
  const lines = [
    `Usage today (UTC ${utc}, RPD resets at next UTC midnight; RPM is rolling 60s). Pool mode: ${router.getMode()}.`,
  ];
  for (const p of snap) {
    const parts: string[] = [];
    const rpmTag = p.rpmSource === "live" ? "live" : "est.";
    const rpdTag = p.rpdSource === "live" ? "live" : "est.";
    parts.push(`RPM ${p.rpmCount}${p.rpmCap !== undefined ? "/" + p.rpmCap : ""} [${rpmTag}]`);
    if (p.estimatedDailyBudget !== undefined) {
      // For live source we know remaining directly; for estimated we count
      // successes. The displayed numerator is "used today" = cap - remaining.
      const used = p.rpdSource === "live"
        ? Math.max(0, p.estimatedDailyBudget - Math.round((p.remainingPct ?? 0) / 100 * p.estimatedDailyBudget))
        : p.successCount;
      const pct = p.remainingPct !== undefined ? `~${p.remainingPct.toFixed(0)}% left` : "";
      parts.push(`RPD ${used}/${p.estimatedDailyBudget}${pct ? ` (${pct})` : ""} [${rpdTag}]`);
    } else {
      parts.push(`${p.successCount} successful`);
    }
    parts.push(`rejected: ${p.rateLimitCount}`);
    let suffix = "";
    if (p.cooldownMsRemaining > 0) {
      suffix = `   [cooling ${formatCooldown(p.cooldownMsRemaining)}]`;
    }
    lines.push(`  ${p.id.padEnd(28)} ${parts.join("  ")}${suffix}`);
  }
  return lines.join("\n");
}

/** Show sub-minute cooldowns with seconds precision; minutes for longer. */
function formatCooldown(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `0:${String(secs).padStart(2, "0")}`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}
