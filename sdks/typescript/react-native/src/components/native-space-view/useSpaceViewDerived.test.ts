import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewport = vi.hoisted(() => ({ width: 500 }));
const defaultViewportWidth = 500;

vi.mock("react", () => ({
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: viewport.width, height: 800 }),
}));

import { useSpaceViewDerived } from "./useSpaceViewDerived";

describe("useSpaceViewDerived", () => {
  beforeEach(() => {
    viewport.width = defaultViewportWidth;
  });

  afterEach(() => {
    viewport.width = defaultViewportWidth;
  });

  it("marks compact whiteboard layouts and keeps the local participant first", () => {
    const local = { id: "local", screenShareTrack: null };
    const remote = { id: "remote", screenShareTrack: null };

    const derived = useSpaceViewDerived({
      participants: [remote] as never,
      localParticipant: local as never,
      screenShare: { isActive: false, isLocalSharing: false, sharerParticipantId: null, videoTrack: null },
      isWhiteboardOpen: true,
    });

    expect(derived.isCompactViewport).toBe(true);
    expect(derived.primaryContent).toBe("whiteboard");
    expect(derived.allParticipants.map((participant) => participant.id)).toEqual(["local", "remote"]);
  });

  it("uses the wide viewport to expose an active remote screen share", () => {
    viewport.width = 1024;
    const local = { id: "local", screenShareTrack: null };
    const remote = { id: "remote", screenShareTrack: null };
    const track = { readyState: "live" } as never;

    const derived = useSpaceViewDerived({
      participants: [remote] as never,
      localParticipant: local as never,
      screenShare: { isActive: true, isLocalSharing: false, sharerParticipantId: "remote", videoTrack: track },
      isWhiteboardOpen: false,
    });

    expect(derived.isCompactViewport).toBe(false);
    expect(derived.primaryContent).toBe("screen-share");
    expect(derived.screenSharer).toBe(remote);
    expect(derived.screenShareTrack).toBe(track);
  });
});
