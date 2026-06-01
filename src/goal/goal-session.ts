import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GoalStep {
  prompt: string;
  result?: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt?: number;
  finishedAt?: number;
}

export interface GoalSession {
  goalId: string;
  description: string;
  steps: GoalStep[];
  status: "running" | "paused" | "done" | "failed";
  /** Timestamp when the loop is expected to resume after a quota wait. */
  pausedUntil?: number;
  createdAt: number;
  updatedAt: number;
}

/** Generates a short random goal ID. */
export function newGoalId(): string {
  return "goal_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

/**
 * Synchronous file-backed store for GoalSession objects.
 * One JSON file per goal at <dir>/<goalId>.json.
 * Mirrors the FileStateStore pattern in src/state.ts.
 */
export class GoalStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".multi-agent", "goals");
  }

  private path(goalId: string): string {
    return join(this.dir, `${goalId}.json`);
  }

  save(session: GoalSession): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path(session.goalId), JSON.stringify(session, null, 2), "utf8");
    } catch (err) {
      console.error(`[goal-store] failed to save ${session.goalId}: ${(err as Error).message}`);
    }
  }

  load(goalId: string): GoalSession | null {
    const p = this.path(goalId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as GoalSession;
    } catch {
      return null;
    }
  }

  list(): GoalSession[] {
    if (!existsSync(this.dir)) return [];
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try { return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as GoalSession; }
          catch { return null; }
        })
        .filter((s): s is GoalSession => s !== null);
    } catch {
      return [];
    }
  }

  delete(goalId: string): boolean {
    const p = this.path(goalId);
    if (!existsSync(p)) return false;
    try {
      rmSync(p);
      return true;
    } catch {
      return false;
    }
  }
}
