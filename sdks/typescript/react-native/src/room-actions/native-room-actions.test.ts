import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { createNativeMediaRequestPrompt, createNativeRoomActionCommands, projectNativeRoomActions } from "./native-room-actions";

describe("native room-actions bridge", () => {
  it("projects only negotiated chat and reactions into native view models", () => {
    const projection = projectNativeRoomActions(
      snapshot({
        roomActions: { phase: "healthy", capabilities: ["sendChat", "sendReaction"], error: null },
        chat: {
          status: "ready",
          messages: [
            {
              messageId: "message-1",
              clientMessageId: "client-1",
              sequence: "1",
              participantSessionId: "participant-1",
              displayName: "Ada",
              text: "Hello",
              createdAt: "2026-07-29T20:00:00.000Z",
            },
          ],
          pending: [],
          hasOlder: false,
          historyTruncated: false,
          retainedFloorSequence: null,
          unreadCount: 1,
          error: null,
        },
        reactions: [
          {
            eventId: "reaction-1",
            participantSessionId: "participant-1",
            displayName: "Ada",
            reaction: "🎉",
            occurredAt: "2026-07-29T20:00:00.000Z",
            expiresAt: "2026-07-29T20:00:05.000Z",
          },
        ],
      }),
    );

    expect(projection).toEqual(
      expect.objectContaining({
        chatEnabled: true,
        reactionEnabled: true,
        messages: [expect.objectContaining({ id: "message-1", senderId: "participant-1", content: "Hello" })],
        reactions: [expect.objectContaining({ id: "reaction-1", emoji: "🎉", participantName: "Ada" })],
      }),
    );
  });

  it("delegates chat, reaction, and directed media actions to the injected canonical store", async () => {
    const store = actionStore();
    const commands = createNativeRoomActionCommands(store);

    await commands.sendChatMessage("Hello");
    await commands.sendReaction("👍");
    await commands.requestUnmute("participant-2");
    await commands.requestStartCamera("participant-2");
    await commands.muteParticipant("participant-2");
    await commands.stopParticipantCamera("participant-2");
    await commands.removeParticipant("participant-2");

    expect(store.sendChatMessage).toHaveBeenCalledWith({ text: "Hello" });
    expect(store.sendReaction).toHaveBeenCalledWith("👍");
    expect(store.requestUnmute).toHaveBeenCalledWith("participant-2");
    expect(store.requestStartCamera).toHaveBeenCalledWith("participant-2");
    expect(store.muteParticipant).toHaveBeenCalledWith("participant-2");
    expect(store.stopParticipantCamera).toHaveBeenCalledWith("participant-2");
    expect(store.removeParticipant).toHaveBeenCalledWith("participant-2");
  });

  it("maps incoming prompt buttons to accept and decline without legacy fallbacks", async () => {
    const store = actionStore();
    const commands = createNativeRoomActionCommands(store);
    const reportFailure = vi.fn();
    const prompt = createNativeMediaRequestPrompt(
      {
        requestId: "request-1",
        kind: "start_camera",
        actorParticipantSessionId: "host-1",
        actorDisplayName: "Grace",
        expiresAt: "2026-07-29T20:01:00.000Z",
      },
      commands,
      reportFailure,
    );

    prompt.buttons[0]!.onPress();
    prompt.buttons[1]!.onPress();
    await vi.waitFor(() => expect(store.acceptMediaRequest).toHaveBeenCalledWith("request-1"));

    expect(prompt.title).toBe("Camera request");
    expect(store.declineMediaRequest).toHaveBeenCalledWith("request-1");
    expect(reportFailure).not.toHaveBeenCalled();
  });
});

function actionStore(): ChalkSessionStore {
  return {
    sendChatMessage: vi.fn(() => Promise.resolve()),
    sendReaction: vi.fn(() => Promise.resolve()),
    requestUnmute: vi.fn(() => Promise.resolve()),
    requestStartCamera: vi.fn(() => Promise.resolve()),
    muteParticipant: vi.fn(() => Promise.resolve()),
    stopParticipantCamera: vi.fn(() => Promise.resolve()),
    removeParticipant: vi.fn(() => Promise.resolve()),
    acceptMediaRequest: vi.fn(() => Promise.resolve()),
    declineMediaRequest: vi.fn(),
  } as unknown as ChalkSessionStore;
}

function snapshot(overrides: Partial<ChalkSessionSnapshot>): ChalkSessionSnapshot {
  return {
    roomActions: { phase: "disabled", capabilities: [], error: null },
    chat: {
      status: "idle",
      messages: [],
      pending: [],
      hasOlder: false,
      historyTruncated: false,
      retainedFloorSequence: null,
      unreadCount: 0,
      error: null,
    },
    reactions: [],
    incomingMediaRequests: [],
    ...overrides,
  } as ChalkSessionSnapshot;
}
