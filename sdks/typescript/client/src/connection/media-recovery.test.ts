import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessGrantError, parseParsedAccessGrant, requireParsedAccessGrant } from "../access/grant";
import { ConnectionAccessFailure } from "../access/manager";
import { ChalkAPIError } from "../server/errors";
import { CloudflareSFUError } from "../media";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { accessRefreshedAt, mediaRecoveryFixture } from "./media-recovery.test.helpers";

// Sanitized SDK 5.2.4 report timings. Sync stayed live (heartbeat gap: 311 ms).
const observed = { live: 1854, accessRefreshed: accessRefreshedAt, disconnected: 47243, reconnecting: 47494, failed: 57234, exhausted: 57502 };

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

describe("media recovery deadline", () => {
  it.each(["recovers", "keeps failing"] as const)("retries the reported media loss for the full Sync budget when media %s", async (outcome) => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new Error("Transient media failure"));
    await test.run(async (lifecycle) => {
      await test.advanceTo(observed.live);
      expect(lifecycle.getSnapshot().state).toBe("live");
      await test.advanceTo(observed.accessRefreshed);
      expect(lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refreshed", state: "live" }));
      expect(test.access.mock.calls[1]?.[0]).toMatchObject({ reason: "scheduled_refresh", replaceMediaConnection: false });

      await test.advanceTo(observed.disconnected);
      test.mediaPhase("recovering");
      await test.advanceTo(observed.reconnecting);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null, connection: { sync: "healthy" } });
      expect(test.restart).not.toHaveBeenCalled();

      await test.advanceTo(observed.failed);
      test.mediaPhase("failed");
      await test.advanceTo(observed.exhausted);
      expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
      await test.advanceTo(85000);
      expect(test.restart.mock.calls.length).toBeGreaterThan(3);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null, connection: { sync: "healthy" } });
      expect(test.stopSync).not.toHaveBeenCalled();
      expect(test.stopMedia).not.toHaveBeenCalled();
      expect(test.createSync).toHaveBeenCalledTimes(1);
      expect(test.access.mock.calls.slice(2).every(([request]) => request.reason === "media_recovery" && request.replaceMediaConnection && request.expectedParticipantGeneration === 1 && request.currentMediaToken !== undefined)).toBe(true);

      if (outcome === "recovers") {
        test.restart.mockImplementation(async () => test.mediaPhase("live"));
        await test.advanceTo(95000);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null, connection: { sync: "healthy", media: "healthy" } });
        expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
      } else {
        const firstAttempt = lifecycle.getDiagnostics().find((event) => event.event === "recovery_attempt");
        expect(firstAttempt).toBeDefined();
        await test.advanceTo((firstAttempt?.timestamp ?? 0) - test.startedAt + 59999);
        expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
        await test.advanceTo((firstAttempt?.timestamp ?? 0) - test.startedAt + 60001);
        const exhausted = lifecycle.getDiagnostics().find((event) => event.event === "recovery_exhausted");
        expect(exhausted).toMatchObject({ code: "media_recovery_exhausted" });
        expect((exhausted?.timestamp ?? 0) - (firstAttempt?.timestamp ?? 0)).toBeGreaterThanOrEqual(60000);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: { code: "media_recovery_exhausted", recoverable: true } });
        expect(test.stopSync).not.toHaveBeenCalled();
      }
      const retries = lifecycle.getDiagnostics().filter((event) => event.event === "recovery_attempt");
      for (let index = 1; index < retries.length; index++) {
        const gap = (retries[index]?.timestamp ?? 0) - (retries[index - 1]?.timestamp ?? 0);
        expect(gap).toBeGreaterThanOrEqual(250);
        // The first attempt includes the observed 9.74-second peer wait.
        expect(gap).toBeLessThanOrEqual(index === 1 ? 16000 : 6500);
      }
    });
  });

  it.each([401, 403])("does not reclaim another tab's same-generation seat after live media is rejected (%s)", async (status) => {
    const test = mediaRecoveryFixture();
    await test.run(async (lifecycle) => {
      test.setBinding("another-tabs-connection");
      test.mediaPhase("failed");
      test.failMedia(new CloudflareSFUError("Obsolete media binding", "signaling_failed", { status }));
      await test.advanceTo(60000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      expect(test.access).toHaveBeenCalledTimes(1);
      expect(test.restart).not.toHaveBeenCalled();
      expect(test.getBinding()).toBe("another-tabs-connection");
      expect(test.createSync).toHaveBeenCalledTimes(1);
    });
  });

  it.each([401, 403])("does not retry a rejected media restart (%s)", async (status) => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new CloudflareSFUError("Rejected media restart", "signaling_failed", { status }));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(60000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      expect(test.restart).toHaveBeenCalledTimes(1);
      expect(test.access.mock.calls.map(([request]) => request.reason)).toEqual(["join", "media_recovery"]);
    });
  });

  it.each(["restart", "scheduled refresh"] as const)("lets Episode end win a rejected %s", async (source) => {
    const test = mediaRecoveryFixture();
    test.status.mockResolvedValue("ending");
    if (source === "restart") test.restart.mockRejectedValue(new CloudflareSFUError("Close rejected during end", "signaling_failed", { status: 403 }));
    else {
      const original = test.access.getMockImplementation();
      if (!original) throw new Error("Missing access provider");
      test.access.mockImplementation(async (request) => {
        if (request.reason === "scheduled_refresh") throw new ChalkAPIError({ code: "access.invalid", status: 403, retryable: false });
        return original(request);
      });
    }
    await test.run(async (lifecycle) => {
      if (source === "restart") test.mediaPhase("failed");
      await test.advanceTo(observed.accessRefreshed + 100);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "left", episodeEnded: true, failure: null });
      expect(lifecycle.getDiagnostics().filter((event) => event.event === "connection_failed")).toEqual([]);
    });
  });

  it("ignores a queued rejection for a binding replaced by a newer recovery grant", async () => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new Error("Transient media failure"));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(1000);
      expect(test.getBinding()).not.toBe("connection-1");
      test.failMedia(new CloudflareSFUError("Old binding rejected", "signaling_failed", { status: 403 }), "connection-1");
      await test.advanceTo(1500);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null });
    });
  });

  it.each(["server", "response", "direct"] as const)("requires explicit rejoin when current media reports a %s replacement conflict", async (source) => {
    const test = mediaRecoveryFixture();
    await test.run(async (lifecycle) => {
      const serverConflict = new ChalkAPIError({ code: "participant.connection_superseded", status: 409, retryable: false });
      const conflict = source === "server" ? new ConnectionAccessFailure({ code: "access.invalid", cause: serverConflict }) : source === "direct" ? serverConflict : new AccessGrantError(undefined, "connection_superseded");
      test.failMedia(conflict, test.getBinding());
      await test.advanceTo(1000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false, message: expect.stringContaining("Another tab or device may be using it") } });
      expect(test.access).toHaveBeenCalledTimes(1);
      expect(test.restart).not.toHaveBeenCalled();
    });
  });

  it.each(["server", "response"] as const)("preserves a takeover at recovery second 20 with a %s conflict at second 25", async (conflictSource) => {
    const test = mediaRecoveryFixture(undefined, conflictSource);
    test.restart.mockRejectedValue(new Error("Transient media failure"));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(20000);
      expect(lifecycle.getSnapshot().state).toBe("reconnecting");
      test.setBinding("legitimate-new-tab");
      await test.advanceTo(25500);
      expect(test.getBinding()).toBe("legitimate-new-tab");
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false, message: expect.stringContaining("Another tab or device may be using it") } });
      const count = test.access.mock.calls.length;
      await test.advanceTo(60000);
      expect(test.access).toHaveBeenCalledTimes(count);
    });
  });

  it("keeps an identical pending replacement recoverable after the provider timeout and recovers its replay", async () => {
    const test = mediaRecoveryFixture();
    const original = test.access.getMockImplementation();
    if (!original) throw new Error("Missing access provider");
    const committed = parseParsedAccessGrant(opaqueAccessGrant(2, "2", "connection-2"));
    let resolveFirst: (grant: typeof committed) => void = () => {};
    let attempts = 0;
    test.access.mockImplementation(async (request) => {
      if (!request.replaceMediaConnection) return original(request);
      if (++attempts === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      if (attempts === 2) return requireParsedAccessGrant(Response.json({ error: { code: "participant.media_replacement_pending" } }, { status: 409 }));
      return committed;
    });
    test.restart.mockImplementation(async () => test.mediaPhase("live"));
    try {
      await test.run(async (lifecycle) => {
        test.mediaPhase("failed");
        await test.advanceTo(9000);
        expect(attempts).toBe(2);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null, connection: { sync: "healthy" } });
        expect(test.stopMedia).not.toHaveBeenCalled();
        expect(test.stopSync).not.toHaveBeenCalled();
        resolveFirst(committed);
        await test.advanceTo(13000);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null });
        expect(attempts).toBe(3);
        const retries = test.access.mock.calls.filter(([request]) => request.replaceMediaConnection);
        expect(retries.every(([request]) => request.expectedMediaConnectionId === "connection-1" && request.currentMediaToken === retries[0]?.[0].currentMediaToken)).toBe(true);
      });
    } finally {
      resolveFirst(committed);
    }
  });

  it.each([undefined, [0]])("uses at most twelve replacement grants per minute even with backoff %s", async (backoffMs) => {
    const test = mediaRecoveryFixture(backoffMs);
    test.restart.mockRejectedValue(new Error("Transient media failure"));
    await test.run(async () => {
      test.mediaPhase("failed");
      await test.advanceTo(60000);
      const grants = test.access.mock.calls.filter(([request]) => request.replaceMediaConnection);
      expect(grants.length).toBeGreaterThan(3);
      expect(grants.length).toBeLessThanOrEqual(12);
      expect(test.restart).toHaveBeenCalledTimes(grants.length);
    });
  });
});

