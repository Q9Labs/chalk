import { EpisodeStatusError } from "./episode-status";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseParsedAccessGrant } from "../access/grant";
import { ChalkAPIError } from "../server/errors";
import { CloudflareSFUError } from "../media";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { mediaRecoveryFixture } from "../../tests/helpers/media-recovery-fixture";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

import { createDefaultConnectionDependencies } from "./production";

describe("media rejection classification regressions", () => {
  it("settles permanent status HTTP 401 instead of leaving a rejected client live", async () => {
    const test = mediaRecoveryFixture();
    const lookup = createDefaultConnectionDependencies({ apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync" }).getEpisodeStatus!;
    const http = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", http);
    test.status.mockImplementation(lookup);
    await test.run(async (lifecycle) => {
      test.failMedia(new CloudflareSFUError("Expired/revoked credential", "signaling_failed", { status: 403 }));
      await test.advanceTo(60000);
      // A rejected status credential does not prove the Episode is active.
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "access_unavailable", recoverable: true } });
      expect(test.status).toHaveBeenCalledOnce();
    });
  });

  it("does not replace the media binding while rejection classification is unavailable", async () => {
    const test = mediaRecoveryFixture();
    test.status.mockRejectedValue(new Error("Status temporarily unavailable"));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      test.failMedia(new CloudflareSFUError("Current binding denied", "signaling_failed", { status: 403 }));
      await test.advanceTo(1500);
      expect(test.getBinding()).toBe("connection-1");
      expect(test.restart).not.toHaveBeenCalled();
    });
  });

  it("does not retry an obsolete token after a successful same-binding credential refresh", async () => {
    const test = mediaRecoveryFixture();
    const original = test.access.getMockImplementation()!;
    let refreshedToken = "";
    test.access.mockImplementation(async (request) => {
      const value = await original(request);
      if (request.reason === "join") return value;
      const fresh = opaqueAccessGrant(1, "refreshed", value.media.clientPayload.connectionId);
      const next = parseParsedAccessGrant({ ...fresh, sync: { ...fresh.sync, expires_at: value.sync.expiresAt }, media: { ...fresh.media, expires_at: value.media.expiresAt } });
      refreshedToken = next.media.token;
      return next;
    });
    test.status.mockImplementation(async (grant) => {
      if (refreshedToken && grant.media.token === refreshedToken) return "active";
      throw new Error("Status unavailable for old credential");
    });
    await test.run(async (lifecycle) => {
      test.failMedia(new CloudflareSFUError("Rejected", "signaling_failed", { status: 403 }));
      await test.advanceTo(30000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access" } });
    });
  });
});

it.each([429, 503])("respects Retry-After on status HTTP %s while keeping Sync", async (status) => {
  const test = mediaRecoveryFixture();
  const lookup = createDefaultConnectionDependencies({ apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync" }).getEpisodeStatus!;
  vi.stubGlobal("fetch", async () => new Response(null, { status, headers: { "Retry-After": "120" } }));
  test.status.mockImplementation(lookup);
  await test.run(async (lifecycle) => {
    test.failMedia(new CloudflareSFUError("Publications rejected", "signaling_failed", { status: 403 }));
    await test.advanceTo(2500);
    expect(test.status).toHaveBeenCalledOnce();
    expect(test.stopSync).not.toHaveBeenCalled();
  });
});

it("settles unavailable status at the total budget without inventing revocation", async () => {
  const test = mediaRecoveryFixture();
  test.status.mockRejectedValue(new Error("Unavailable"));
  await test.run(async (lifecycle) => {
    test.mediaPhase("failed");
    test.failMedia(new CloudflareSFUError("Rejected", "signaling_failed", { status: 403 }));
    await test.advanceTo(61000);
    expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "access_unavailable", recoverable: true } });
    expect(test.access.mock.calls.filter(([r]) => r.replaceMediaConnection)).toHaveLength(0);
    expect(test.status.mock.calls.length).toBeLessThan(20);
  });
});
it("retains the public Effect confirmEpisodeEnded capability", async () => {
  const test = mediaRecoveryFixture();
  await test.run(async (lifecycle) => {
    await Effect.runPromise(lifecycle.confirmEpisodeEnded);
    test.failMedia(new CloudflareSFUError("Ended", "signaling_failed", { status: 403 }));
    await test.advanceTo(100);
    expect(lifecycle.getSnapshot()).toMatchObject({ state: "left", failure: null, episodeEnded: true });
    expect(test.status).not.toHaveBeenCalled();
  });
});

it.each([
  { first: 410, next: 403, status: "active" },
  { first: 410, next: 403, status: "ending" },
  { first: 403, next: 410, status: "active" },
] as const)("preserves rejection priority for $first then $next while Episode is $status", async ({ first, next, status }) => {
  const test = mediaRecoveryFixture();
  let answer!: (status: "active" | "ending") => void;
  test.status.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  await test.run(async (lifecycle) => {
    test.failMedia(new CloudflareSFUError("First rejection", "signaling_failed", { status: first }));
    await test.advanceTo(100);
    test.failMedia(new CloudflareSFUError("Second rejection", "signaling_failed", { status: next }));
    await test.advanceTo(200);
    answer(status);
    await test.advanceTo(500);
    if (status === "active") expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
    else expect(lifecycle.getSnapshot()).toMatchObject({ state: "left", failure: null, episodeEnded: true });
    expect(test.access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
  });
});

it("resumes status reads when a rejected credential is later refreshed on the same binding", async () => {
  const test = mediaRecoveryFixture();
  const original = test.access.getMockImplementation()!;
  let refreshes = 0;
  let freshToken = "";
  test.access.mockImplementation(async (request) => {
    const value = await original(request);
    if (request.reason === "join") return value;
    if (++refreshes === 1) throw new Error("Credential refresh temporarily unavailable");
    const fresh = opaqueAccessGrant(1, "fresh-after-auth-rejection", value.media.clientPayload.connectionId);
    const next = parseParsedAccessGrant({ ...fresh, sync: { ...fresh.sync, expires_at: value.sync.expiresAt }, media: { ...fresh.media, expires_at: value.media.expiresAt } });
    freshToken = next.media.token;
    return next;
  });
  test.status.mockImplementation(async (grant) => {
    if (freshToken && grant.media.token === freshToken) return "active";
    throw new EpisodeStatusError(401);
  });
  await test.run(async (lifecycle) => {
    test.failMedia(new CloudflareSFUError("Rejected", "signaling_failed", { status: 403 }));
    await test.advanceTo(30000);
    expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
    expect(test.status.mock.calls.some(([grant]) => grant.media.token === freshToken)).toBe(true);
    expect(test.access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
  });
});

it.each([
  { status: 401, refresh: "unchanged" },
  { status: 401, refresh: "failed" },
  { status: 403, refresh: "unchanged" },
  { status: 403, refresh: "failed" },
] as const)("does not reuse a credential after status $status and $refresh refresh", async ({ status, refresh }) => {
  const test = mediaRecoveryFixture();
  if (refresh === "failed") {
    const original = test.access.getMockImplementation()!;
    test.access.mockImplementation((request) => (request.reason === "join" ? original(request) : Promise.reject(new Error("Refresh unavailable"))));
  }
  test.status.mockRejectedValue(new EpisodeStatusError(status));
  await test.run(async () => {
    test.failMedia(new CloudflareSFUError("Rejected", "signaling_failed", { status: 403 }));
    await test.advanceTo(2500);
    expect(test.status).toHaveBeenCalledOnce();
    expect(test.stopSync).not.toHaveBeenCalled();
    expect(test.access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
  });
});

it.each(["active", "ending", "ended"] as const)("does not treat refresh access.forbidden as proof of revocation when Episode is %s", async (status) => {
  const test = mediaRecoveryFixture();
  const original = test.access.getMockImplementation()!;
  test.access.mockImplementation((request) => (request.reason === "join" ? original(request) : Promise.reject(new ChalkAPIError({ code: "access.forbidden", status: 403, retryable: false }))));
  test.status.mockResolvedValue(status);
  await test.run(async (lifecycle) => {
    await test.advanceTo(11000);
    expect(test.access.mock.calls.some(([request]) => request.reason === "scheduled_refresh")).toBe(true);
    expect(lifecycle.getSnapshot().state).toBe("live");
    test.failMedia(new CloudflareSFUError("Denied", "signaling_failed", { status: 403 }));
    await test.advanceTo(11200);
    if (status === "active") expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
    else expect(lifecycle.getSnapshot()).toMatchObject({ state: "left", failure: null, episodeEnded: true });
    expect(test.stopMedia).toHaveBeenCalledOnce();
    expect(test.access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
  });
});

it.each([401, 403])("REVIEW stronger %s during the 410 decision commit is not lost", async (status) => {
  const test = mediaRecoveryFixture();
  let answer: (status: "active") => void = () => {
    throw new Error("missing read");
  };
  test.status
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    )
    .mockResolvedValue("active");
  await test.run(async (lifecycle) => {
    test.mediaPhase("failed");
    test.failMedia(new CloudflareSFUError("gone", "signaling_failed", { status: 410 }));
    await test.advanceTo(500);
    let sent = false;
    const unsubscribe = lifecycle.subscribe(() => {
      if (sent) return;
      sent = true;
      test.failMedia(new CloudflareSFUError("revoked while committing recovery", "signaling_failed", { status }));
    });
    answer("active");
    await test.advanceTo(1500);
    unsubscribe();
    expect(sent).toBe(true);
    expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
  });
});
