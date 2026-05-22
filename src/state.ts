import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderUsage {
  successCount: number;
  rateLimitCount: number;
  cooldownUntil: number;
  /** UTC date "YYYY-MM-DD" of when the counters last reset. Used for daily rollover. */
  lastResetUtcDay: string;
}

export interface StateStore {
  load(): Record<string, ProviderUsage>;
  save(state: Record<string, ProviderUsage>): void;
}

/** Returns the UTC calendar day as "YYYY-MM-DD". */
export function utcDay(now?: number): string {
  return new Date(now ?? Date.now()).toISOString().slice(0, 10);
}

export function emptyUsage(day: string): ProviderUsage {
  return { successCount: 0, rateLimitCount: 0, cooldownUntil: 0, lastResetUtcDay: day };
}

/**
 * Resets daily counters on a usage record if the UTC day has changed.
 * Cooldowns are absolute timestamps and roll over naturally.
 */
export function rollover(usage: ProviderUsage, today: string): ProviderUsage {
  if (usage.lastResetUtcDay === today) return usage;
  return { ...usage, successCount: 0, rateLimitCount: 0, lastResetUtcDay: today };
}

/** In-process only. Used by tests and by code that opts out of persistence. */
export class InMemoryStateStore implements StateStore {
  private state: Record<string, ProviderUsage> = {};
  load(): Record<string, ProviderUsage> {
    return JSON.parse(JSON.stringify(this.state));
  }
  save(state: Record<string, ProviderUsage>): void {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

/**
 * Synchronous JSON file backing. Sync I/O is fine for CLI/single-process use;
 * for a future server scenario, swap in an async implementation behind the
 * same StateStore interface.
 *
 * Default path: ~/.multi-agent/state.json (cross-platform via os.homedir()).
 * Corrupt or unreadable files fall back to empty state with a stderr warning
 * rather than crashing — usage data is advisory, not critical.
 */
export class FileStateStore implements StateStore {
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(homedir(), ".multi-agent", "state.json");
  }

  load(): Record<string, ProviderUsage> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "providers" in parsed) {
        return (parsed.providers ?? {}) as Record<string, ProviderUsage>;
      }
      return {};
    } catch (err) {
      console.error(`[state] failed to read ${this.path}: ${(err as Error).message}. Starting fresh.`);
      return {};
    }
  }

  save(state: Record<string, ProviderUsage>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = JSON.stringify({ version: 1, providers: state }, null, 2);
      writeFileSync(this.path, body, "utf8");
    } catch (err) {
      console.error(`[state] failed to write ${this.path}: ${(err as Error).message}.`);
    }
  }
}
