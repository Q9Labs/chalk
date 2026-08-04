import { describe, expect, it } from "vitest";

import type { V1EpisodeSnapshot } from "../sync";
import { initialConnectionSnapshot, projectConnectionSnapshot } from "./snapshot";

describe("Connection snapshot projection", () => {
  it("creates a deeply immutable idle snapshot", () => {
    const snapshot = initialConnectionSnapshot();
    expect(snapshot).toMatchObject({ state: "idle", subject: null, connection: { sync: "idle", media: "idle" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.localMedia)).toBe(true);
    expect(Object.isFrozen(snapshot.localMedia.camera)).toBe(true);
    expect(snapshot.collaboration).toEqual({ phase: "disabled", version: null, capabilities: [], error: null });
    expect(snapshot.chat).toMatchObject({ status: "idle", messages: [], pending: [], unreadCount: 0 });
    expect(snapshot.whiteboard).toMatchObject({ status: "unsubscribed", canDraw: false, canClear: false });
    expect(Object.isFrozen(snapshot.collaboration.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.chat.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.whiteboard.capabilities)).toBe(true);
  });

  it("projects failed intended media without manufacturing tracks or healthy connections", () => {
    const snapshot = projectConnectionSnapshot({
      state: "failed",
      subject: null,
      sync: null,
      media: null,
      localTracks: new Map(),
      localIntent: { microphone: true, camera: false },
      failure: { code: "permission_denied", action: "join", recoverable: true, message: "denied" },
    });

    expect(snapshot.localMedia.microphone).toMatchObject({ state: "failed", track: null });
    expect(snapshot.localMedia.camera).toMatchObject({ state: "unavailable", track: null });
    expect(snapshot.failure).toMatchObject({ code: "permission_denied" });
  });

  it("projects authoritative participant media and deeply freezes command state", () => {
    const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
    const sync = {
      connection: { phase: "live" },
      participantId,
      participantGeneration: 1,
      control: {
        revision: 1,
        stateSchemaVersion: 1,
        stateDigest: "a".repeat(64),
        status: "active",
        admissionPolicy: "open",
        deadlineAtMs: 1,
        deadlineGeneration: 1,
        roleCapabilities: { owner: ["publishAudio"], collaborator: [], observer: [] },
        recording: null,
        participants: [
          {
            participantId,
            displayName: "Ada",
            handRaised: false,
            admissionRevision: 1,
            role: "owner",
            eligibleRoles: ["owner", "collaborator"],
            capabilities: ["publishAudio"],
          },
        ],
        admissionRequests: [],
      },
      optimisticControl: null,
      media: {
        projectionId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22",
        sequence: 1,
        items: [{ participantId, source: "microphone", enabled: true, publicationId: "publication-1" }],
      },
      presence: null,
      mediaPlane: { local: [], remote: [] },
      localMedia: { microphone: "enabled", camera: "disabled", screen: "disabled" },
      pendingCommandCount: 0,
    } satisfies V1EpisodeSnapshot;

    const snapshot = projectConnectionSnapshot({
      state: "live",
      subject: null,
      sync,
      media: null,
      localTracks: new Map(),
      localIntent: { microphone: false, camera: false },
      failure: null,
      collaboration: { phase: "healthy", version: 1, capabilities: ["sendReaction", "sendChat"], error: null },
      participantCollaborationCapabilities: { [participantId]: ["sendReaction", "sendChat"] },
      reactions: [
        {
          eventId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
          participantId,
          displayName: "Ada",
          reaction: "🎉",
          occurredAt: "2026-07-29T14:00:00.000Z",
          expiresAt: "2026-07-29T14:00:05.000Z",
        },
      ],
    });

    expect(snapshot.participantMedia[participantId]).toEqual({
      microphone: "active",
      camera: "inactive",
      screenShare: "inactive",
    });
    expect(Object.isFrozen(snapshot.participantMedia[participantId])).toBe(true);
    expect(Object.isFrozen(snapshot.participantCollaborationCapabilities[participantId])).toBe(true);
    expect(Object.isFrozen(snapshot.reactions[0])).toBe(true);
  });
});
