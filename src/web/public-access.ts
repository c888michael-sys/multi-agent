import { createHash, randomBytes } from "node:crypto";

const INVITE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REDEEM_ATTEMPTS = 10;
const MAX_TURNS_PER_WINDOW = 10;

export const PUBLIC_SESSION_COOKIE = "__Host-lattice_session";

export interface PublicSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface StoredSession extends PublicSession {
  turns: number[];
  activeGenerations: number;
}

export class PublicAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "PAUSED" | "INVALID_INVITE" | "RATE_LIMITED" | "BUSY",
    public readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "PublicAccessError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function recent(values: number[], now: number): number[] {
  return values.filter((value) => now - value < RATE_WINDOW_MS);
}

/** In-memory public access state. A process restart fails closed (paused). */
export class PublicAccessManager {
  private enabled = false;
  private readonly invites = new Map<string, number>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly redeemAttempts = new Map<string, number[]>();
  private modelPolicyRevision = 0;

  constructor(private readonly now: () => number = Date.now) {}

  issueInvite(ttlMs = INVITE_TTL_MS): { token: string; expiresAt: number } {
    const token = opaqueToken();
    const expiresAt = this.now() + ttlMs;
    this.invites.clear();
    this.invites.set(tokenHash(token), expiresAt);
    this.enabled = true;
    return { token, expiresAt };
  }

  redeem(token: string, source: string): { sessionToken: string; session: PublicSession } {
    const now = this.now();
    this.prune(now);
    const attempts = recent(this.redeemAttempts.get(source) ?? [], now);
    if (attempts.length >= MAX_REDEEM_ATTEMPTS) {
      throw new PublicAccessError("too many invite attempts", "RATE_LIMITED", RATE_WINDOW_MS - (now - attempts[0]!));
    }
    attempts.push(now);
    this.redeemAttempts.set(source, attempts);
    if (!this.enabled) throw new PublicAccessError("public access is paused", "PAUSED");

    const hash = tokenHash(token);
    const inviteExpiry = this.invites.get(hash);
    if (!inviteExpiry || inviteExpiry <= now) {
      this.invites.delete(hash);
      throw new PublicAccessError("invite is invalid, expired, or already used", "INVALID_INVITE");
    }
    // Delete before creating the session so even a later failure cannot make
    // the link reusable.
    this.invites.delete(hash);

    const sessionToken = opaqueToken();
    const session: StoredSession = {
      id: opaqueToken(),
      csrfToken: opaqueToken(),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      turns: [],
      activeGenerations: 0,
    };
    this.sessions.set(tokenHash(sessionToken), session);
    return { sessionToken, session: this.publicSession(session) };
  }

  authenticate(sessionToken: string | undefined): PublicSession | null {
    if (!this.enabled || !sessionToken) return null;
    const now = this.now();
    this.prune(now);
    const session = this.sessions.get(tokenHash(sessionToken));
    if (!session || now - session.lastSeenAt >= SESSION_IDLE_MS || session.expiresAt <= now) return null;
    session.lastSeenAt = now;
    return this.publicSession(session);
  }

  logout(sessionToken: string | undefined): void {
    if (sessionToken) this.sessions.delete(tokenHash(sessionToken));
  }

  pause(): void {
    this.enabled = false;
    this.invites.clear();
    this.sessions.clear();
  }

  status(): { enabled: boolean; paused: boolean; pendingInvites: number; sessions: number } {
    this.prune(this.now());
    return {
      enabled: this.enabled,
      paused: !this.enabled,
      pendingInvites: this.invites.size,
      sessions: this.sessions.size,
    };
  }

  policyVersion(): number {
    return this.modelPolicyRevision;
  }

  modelPolicyChanged(): void {
    this.modelPolicyRevision += 1;
  }

  beginGeneration(sessionId: string): () => void {
    const now = this.now();
    const session = [...this.sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!this.enabled || !session) throw new PublicAccessError("public session is no longer active", "PAUSED");
    session.turns = recent(session.turns, now);
    if (session.activeGenerations >= 1) {
      throw new PublicAccessError("another generation is already running", "BUSY", 1000);
    }
    if (session.turns.length >= MAX_TURNS_PER_WINDOW) {
      throw new PublicAccessError("chat rate limit reached", "RATE_LIMITED", RATE_WINDOW_MS - (now - session.turns[0]!));
    }
    session.turns.push(now);
    session.activeGenerations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.activeGenerations = Math.max(0, session.activeGenerations - 1);
    };
  }

  private publicSession(session: StoredSession): PublicSession {
    const { id, csrfToken, createdAt, lastSeenAt, expiresAt } = session;
    return { id, csrfToken, createdAt, lastSeenAt, expiresAt };
  }

  private prune(now: number): void {
    for (const [hash, expiry] of this.invites) {
      if (expiry <= now) this.invites.delete(hash);
    }
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now || now - session.lastSeenAt >= SESSION_IDLE_MS) this.sessions.delete(hash);
    }
    for (const [source, values] of this.redeemAttempts) {
      const kept = recent(values, now);
      if (kept.length) this.redeemAttempts.set(source, kept);
      else this.redeemAttempts.delete(source);
    }
  }
}

export function cookieValue(header: string | undefined, name = PUBLIC_SESSION_COOKIE): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function publicSessionCookie(token: string, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)): string {
  return `${PUBLIC_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearPublicSessionCookie(): string {
  return `${PUBLIC_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}
