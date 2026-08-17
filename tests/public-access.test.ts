import { describe, expect, it } from "vitest";
import { PublicAccessError, PublicAccessManager, cookieValue, publicSessionCookie } from "../src/web/public-access.js";

describe("PublicAccessManager", () => {
  it("redeems an invite exactly once and authenticates only the issued session", () => {
    const manager = new PublicAccessManager(() => 1_000);
    const invite = manager.issueInvite();
    const redeemed = manager.redeem(invite.token, "127.0.0.1");

    expect(manager.authenticate(redeemed.sessionToken)?.id).toBe(redeemed.session.id);
    expect(manager.status()).toMatchObject({ enabled: true, pendingInvites: 0, sessions: 1 });
    expect(() => manager.redeem(invite.token, "127.0.0.2")).toThrowError(PublicAccessError);
    expect(manager.authenticate("not-a-session")).toBeNull();
  });

  it("pausing revokes sessions and fails closed", () => {
    const manager = new PublicAccessManager(() => 1_000);
    const redeemed = manager.redeem(manager.issueInvite().token, "friend");
    manager.pause();
    expect(manager.authenticate(redeemed.sessionToken)).toBeNull();
    expect(manager.status()).toEqual({ enabled: false, paused: true, pendingInvites: 0, sessions: 0 });
  });

  it("limits each session to one active generation and ten turns per minute", () => {
    let now = 1_000;
    const manager = new PublicAccessManager(() => now);
    const redeemed = manager.redeem(manager.issueInvite().token, "friend");
    const release = manager.beginGeneration(redeemed.session.id);
    expect(() => manager.beginGeneration(redeemed.session.id)).toThrowError(/already running/);
    release();
    for (let index = 1; index < 10; index += 1) manager.beginGeneration(redeemed.session.id)();
    expect(() => manager.beginGeneration(redeemed.session.id)).toThrowError(/rate limit/);
    now += 60_001;
    expect(() => manager.beginGeneration(redeemed.session.id)()).not.toThrow();
  });

  it("uses a Secure HttpOnly host cookie", () => {
    const header = publicSessionCookie("abc");
    expect(header).toContain("__Host-lattice_session=abc");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(cookieValue("other=x; __Host-lattice_session=abc")).toBe("abc");
  });
});
