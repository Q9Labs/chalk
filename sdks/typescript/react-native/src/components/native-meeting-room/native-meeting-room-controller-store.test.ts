import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNativeMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import { NativeMeetingRoomControllerStore } from "./native-meeting-room-controller-store";

const diagnostics = buildNativeMeetingRoomDiagnosticsSnapshot({
  featureFlags: {
    chat: true,
    participants: true,
    transcripts: true,
    settings: true,
    screenShare: true,
    recording: true,
    reactions: true,
    handRaise: true,
    whiteboard: true,
  },
  isHost: false,
  participantCount: 0,
  raisedHandCount: 0,
  unreadChatCount: 0,
  isScreenShareActive: false,
  isLocalScreenSharing: false,
  screenShareSharerParticipantId: null,
});

describe("NativeMeetingRoomControllerStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates local controller state and notifies subscribers", () => {
    const store = new NativeMeetingRoomControllerStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setActionsOpen(true);
    store.setReactionPickerOpen(true);
    store.setChatDraft("hello");
    store.setLocalPanel("transcripts");

    expect(store.getSnapshot()).toMatchObject({
      actionsOpen: true,
      reactionPickerOpen: true,
      chatDraft: "hello",
      localPanel: "transcripts",
    });
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it("tracks elapsed meeting time while subscribed", () => {
    vi.useFakeTimers();
    const store = new NativeMeetingRoomControllerStore();
    const unsubscribe = store.subscribe(() => {});

    vi.advanceTimersByTime(2_500);
    expect(store.getSnapshot().secondsElapsed).toBe(2);

    unsubscribe();
    vi.advanceTimersByTime(2_000);
    expect(store.getSnapshot().secondsElapsed).toBe(2);
  });

  it("marks chat and emits each diagnostics snapshot once", async () => {
    const store = new NativeMeetingRoomControllerStore();
    const markChatAsRead = vi.fn();
    const onDiagnosticsChange = vi.fn();
    const unsubscribe = store.subscribe(() => {});

    store.sync({ panel: "chat", markChatAsRead, diagnostics, onDiagnosticsChange });
    await Promise.resolve();
    expect(markChatAsRead).toHaveBeenCalledTimes(1);
    expect(onDiagnosticsChange).toHaveBeenCalledTimes(1);

    store.sync({ panel: "chat", markChatAsRead, diagnostics, onDiagnosticsChange });
    await Promise.resolve();
    expect(markChatAsRead).toHaveBeenCalledTimes(1);
    expect(onDiagnosticsChange).toHaveBeenCalledTimes(1);

    store.sync({ panel: null, markChatAsRead, diagnostics, onDiagnosticsChange });
    await Promise.resolve();
    store.sync({ panel: "chat", markChatAsRead, diagnostics, onDiagnosticsChange });
    await Promise.resolve();
    expect(markChatAsRead).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
