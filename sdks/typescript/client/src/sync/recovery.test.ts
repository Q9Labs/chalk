import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, computeStateDigest } from "./canonical";
import { acceptReplayPage, beginRecovery, completeRecovery, RECOVERY_LIMITS, RecoveryValidationError } from "./recovery";
import { event, participantSessionId, stateSchemaVersion } from "./__tests__/runtime";
import type { CanonicalReplica, ControlState, ReplayPageFrame, WelcomeFrame } from "./types";

describe("recovery validation", () => {
  it("requires bounded contiguous pages before the declared recovery head", async () => {
    const initialState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const initial: CanonicalReplica = {
      revision: 1,
      stateSchemaVersion,
      stateDigest: await computeStateDigest(initialState, 1, stateSchemaVersion),
      state: initialState,
    };
    const raisedState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: true }] };
    const raised = event({
      eventId: "event-2",
      name: "hand_raised",
      baseRevision: 1,
      revision: 2,
      payload: { participantSessionId },
      resultingStateDigest: await computeStateDigest(raisedState, 2, stateSchemaVersion),
    });
    const head = { revision: 2, stateSchemaVersion, stateDigest: raised.resultingStateDigest };
    const welcome: WelcomeFrame = { type: "welcome", protocol: 2, participantSessionId, participantSessionGeneration: 1, recoveryId: "recovery-1", mode: "replay", head };
    const plan = beginRecovery(welcome, initial);
    const page: ReplayPageFrame = { type: "replay_page", recoveryId: "recovery-1", firstRevision: 2, lastRevision: 2, events: [raised] };
    const accepted = acceptReplayPage(plan, page);
    const canonical: CanonicalReplica = { revision: 2, stateSchemaVersion, stateDigest: raised.resultingStateDigest, state: raisedState };

    completeRecovery(accepted, { type: "recovery_complete", recoveryId: "recovery-1", head }, canonical);
    expect(() => acceptReplayPage(plan, { ...page, firstRevision: 3, lastRevision: 3 })).toThrow(RecoveryValidationError);
  });

  it("keeps recovery modes and page identities bound to their welcome frame", () => {
    const head = { revision: 1, stateSchemaVersion, stateDigest: "0".repeat(64) };
    const terminal: WelcomeFrame = { type: "welcome", protocol: 2, participantSessionId, participantSessionGeneration: 1, recoveryId: "terminal-1", mode: "terminal", head, terminalReason: "session_ended" };
    const replay: WelcomeFrame = { type: "welcome", protocol: 2, participantSessionId, participantSessionGeneration: 1, recoveryId: "replay-1", mode: "replay", head };
    const replica: CanonicalReplica = { revision: 0, stateSchemaVersion, stateDigest: "f".repeat(64), state: { status: "active", participants: [] } };
    const plan = beginRecovery(replay, replica);

    expect(() => beginRecovery(terminal, replica)).toThrow(RecoveryValidationError);
    expect(() => acceptReplayPage(plan, { type: "replay_page", recoveryId: "other-recovery", firstRevision: 1, lastRevision: 1, events: [] })).toThrow(RecoveryValidationError);
  });

  it("accounts for complete replay bytes as standalone events rather than page envelopes", () => {
    const events = nearLimitReplayEvents();
    const eventBytes = events.reduce((total, event) => total + canonicalJsonBytes(event).byteLength, 0);
    const pages = replayPages(events, 8);
    const pageBytes = pages.reduce((total, page) => total + canonicalJsonBytes(page).byteLength, 0);
    const head = { revision: events.length, stateSchemaVersion, stateDigest: "0".repeat(64) };
    const replica: CanonicalReplica = { revision: 0, stateSchemaVersion, stateDigest: "f".repeat(64), state: { status: "active", participants: [] } };
    let plan = beginRecovery({ type: "welcome", protocol: 2, participantSessionId, participantSessionGeneration: 1, recoveryId: "recovery-near-limit", mode: "replay", head }, replica);

    expect(eventBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.maxReplayBytes);
    expect(pageBytes).toBeGreaterThan(RECOVERY_LIMITS.maxReplayBytes);
    for (const page of pages) {
      expect(canonicalJsonBytes(page).byteLength).toBeLessThanOrEqual(RECOVERY_LIMITS.maxReplayPageBytes);
      plan = acceptReplayPage(plan, page);
    }

    expect(plan.replayBytes).toBe(eventBytes);
    expect(plan.replayEventCount).toBe(events.length);
  });
});

function nearLimitReplayEvents() {
  const eventCount = 128;
  const emptyEventBytes = canonicalJsonBytes(replayEvent(1, "")).byteLength;
  const displayNameBytes = Math.floor((RECOVERY_LIMITS.maxReplayBytes - 1_024) / eventCount) - emptyEventBytes;

  return Array.from({ length: eventCount }, (_, index) => replayEvent(index + 1, "x".repeat(displayNameBytes)));
}

function replayPages(events: ReturnType<typeof nearLimitReplayEvents>, pageSize: number) {
  return Array.from({ length: Math.ceil(events.length / pageSize) }, (_, index) => {
    const pageEvents = events.slice(index * pageSize, (index + 1) * pageSize);
    const firstRevision = pageEvents[0]?.revision;
    const lastRevision = pageEvents.at(-1)?.revision;
    if (!firstRevision || !lastRevision) {
      throw new Error("replay page must contain events");
    }
    return { type: "replay_page" as const, recoveryId: "recovery-near-limit", firstRevision, lastRevision, events: pageEvents };
  });
}

function replayEvent(revision: number, displayName: string) {
  return event({
    eventId: `event-${revision}`,
    name: "participant_joined",
    baseRevision: revision - 1,
    revision,
    payload: { participantSessionId: `participant-${revision}`, displayName },
    resultingStateDigest: "0".repeat(64),
  });
}
