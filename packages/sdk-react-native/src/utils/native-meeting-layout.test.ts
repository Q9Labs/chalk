import { describe, expect, it } from "vitest";
import type { ParticipantState } from "@q9labs/chalk-core";
import { buildCompactParticipantPages, normalizeStageParticipants, resolveNativeMeetingLayout } from "./native-meeting-layout";

type RoomParticipant = ParticipantState["participants"][number];

function track(readyState: "live" | "ended" = "live"): MediaStreamTrack {
  return { readyState } as MediaStreamTrack;
}

function participant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    id: overrides.id ?? "participant-1",
    displayName: overrides.displayName ?? "Participant",
    role: overrides.role ?? "participant",
    isLocal: overrides.isLocal ?? false,
    videoEnabled: overrides.videoEnabled ?? false,
    audioEnabled: overrides.audioEnabled ?? true,
    isScreenSharing: overrides.isScreenSharing ?? false,
    isSpeaking: overrides.isSpeaking ?? false,
    handRaised: overrides.handRaised ?? false,
    connectionQuality: overrides.connectionQuality ?? 100,
    videoTrack: overrides.videoTrack ?? undefined,
    audioTrack: overrides.audioTrack ?? undefined,
    screenShareTrack: overrides.screenShareTrack ?? undefined,
    screenShareAudioTrack: overrides.screenShareAudioTrack ?? undefined,
    joinedAt: overrides.joinedAt ?? new Date(),
    metadata: overrides.metadata ?? {},
  };
}

describe("native-meeting-layout", () => {
  it("normalizes participants to local-first without duplication", () => {
    const local = participant({ id: "local", isLocal: true });
    const remote = participant({ id: "remote" });

    expect(normalizeStageParticipants([remote, local], local).map((item) => item.id)).toEqual(["local", "remote"]);
  });

  it("builds compact grid pages for higher participant counts", () => {
    const participants = Array.from({ length: 9 }, (_, index) => participant({ id: `p-${index + 1}` }));

    expect(buildCompactParticipantPages(participants).map((page) => page.length)).toEqual([4, 4, 1]);
  });

  it("stays in grid mode without whiteboard or a live screen share track", () => {
    const local = participant({ id: "local", isLocal: true });

    const result = resolveNativeMeetingLayout({
      participants: [local],
      localParticipant: local,
      screenShare: {
        isActive: false,
        isLocalSharing: false,
        sharerParticipantId: null,
        videoTrack: null,
      },
      isWhiteboardOpen: false,
      isCompactViewport: true,
    });

    expect(result.primaryContent).toBe("grid");
    expect(result.isStageMode).toBe(false);
  });

  it("uses remote screen share as stage content when a live track exists", () => {
    const local = participant({ id: "local", isLocal: true });
    const remote = participant({ id: "remote", isScreenSharing: true, screenShareTrack: track() });

    const result = resolveNativeMeetingLayout({
      participants: [local, remote],
      localParticipant: local,
      screenShare: {
        isActive: true,
        isLocalSharing: false,
        sharerParticipantId: "remote",
        videoTrack: track(),
      },
      isWhiteboardOpen: false,
      isCompactViewport: true,
    });

    expect(result.primaryContent).toBe("screen-share");
    expect(result.screenSharer?.id).toBe("remote");
    expect(result.isStageMode).toBe(true);
  });

  it("suppresses local screen share into a placeholder stage mode", () => {
    const local = participant({ id: "local", isLocal: true, isScreenSharing: true, screenShareTrack: track() });

    const result = resolveNativeMeetingLayout({
      participants: [local],
      localParticipant: local,
      screenShare: {
        isActive: true,
        isLocalSharing: true,
        sharerParticipantId: "local",
        videoTrack: track(),
      },
      isWhiteboardOpen: false,
      isCompactViewport: true,
    });

    expect(result.primaryContent).toBe("screen-share-placeholder");
    expect(result.isLocalScreenShare).toBe(true);
  });

  it("prefers whiteboard over screen share on compact view", () => {
    const local = participant({ id: "local", isLocal: true });
    const remote = participant({ id: "remote", isScreenSharing: true, screenShareTrack: track() });

    const result = resolveNativeMeetingLayout({
      participants: [local, remote],
      localParticipant: local,
      screenShare: {
        isActive: true,
        isLocalSharing: false,
        sharerParticipantId: "remote",
        videoTrack: track(),
      },
      isWhiteboardOpen: true,
      isCompactViewport: true,
    });

    expect(result.primaryContent).toBe("whiteboard");
    expect(result.isSplit).toBe(false);
  });

  it("uses split stage for whiteboard plus screen share on wide view", () => {
    const local = participant({ id: "local", isLocal: true });
    const remote = participant({ id: "remote", isScreenSharing: true, screenShareTrack: track() });

    const result = resolveNativeMeetingLayout({
      participants: [local, remote],
      localParticipant: local,
      screenShare: {
        isActive: true,
        isLocalSharing: false,
        sharerParticipantId: "remote",
        videoTrack: track(),
      },
      isWhiteboardOpen: true,
      isCompactViewport: false,
    });

    expect(result.primaryContent).toBe("split");
    expect(result.isSplit).toBe(true);
  });

  it("ignores stale screen share state when no live track exists", () => {
    const local = participant({ id: "local", isLocal: true });
    const remote = participant({ id: "remote", isScreenSharing: true, screenShareTrack: track("ended") });

    const result = resolveNativeMeetingLayout({
      participants: [local, remote],
      localParticipant: local,
      screenShare: {
        isActive: true,
        isLocalSharing: false,
        sharerParticipantId: "remote",
        videoTrack: null,
      },
      isWhiteboardOpen: false,
      isCompactViewport: true,
    });

    expect(result.primaryContent).toBe("grid");
    expect(result.showScreenShare).toBe(false);
  });
});
