import type { NativeSpaceSnapshot, SpaceClientStore } from "../client-compat";
import { describe, expect, it, vi } from "vitest";

import { createNativeActionCommands, createNativeMediaRequestPrompt, projectNativeActions } from "./native-room-actions";

describe("native room-actions bridge", () => {
  it("projects only negotiated chat and reactions into native view models", () => {
    const projection = projectNativeActions(
      snapshot({
        subject: {
          episodeId: "episode-1",
          participantId: "participant-local",
          participantGeneration: 2,
        },
        participants: [
          {
            participantId: "participant-2",
            displayName: "Grace",
            handRaised: false,
            role: "participant",
            eligibleRoles: ["participant"],
            capabilities: [],
            media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
          },
        ],
        actions: { phase: "healthy", version: 1, capabilities: ["sendChat", "sendReaction"], error: null },
        chat: {
          status: "ready",
          messages: [
            {
              messageId: "message-1",
              clientMessageId: "client-1",
              sequence: "1",
              participantId: "participant-1",
              displayName: "Ada",
              text: "Hello",
              createdAt: "2026-07-29T20:00:00.000Z",
              attachments: [
                {
                  attachmentId: "attachment-image",
                  fileName: "diagram.png",
                  mimeType: "image/png",
                  byteLength: 2_048,
                },
                {
                  attachmentId: "attachment-file",
                  fileName: "notes.pdf",
                  mimeType: "application/pdf",
                  byteLength: 4_096,
                },
              ],
            },
          ],
          pending: [],
          hasOlder: false,
          historyTruncated: false,
          retainedFloorSequence: null,
          unreadCount: 1,
          readReceipts: [
            {
              participantId: "participant-2",
              participantGeneration: 1,
              readThroughSequence: "10",
              readAt: "2026-07-29T20:01:00.000Z",
            },
            {
              participantId: "participant-local",
              participantGeneration: 2,
              readThroughSequence: "10",
              readAt: "2026-07-29T20:01:00.000Z",
            },
            {
              participantId: "participant-1",
              participantGeneration: 1,
              readThroughSequence: "10",
              readAt: "2026-07-29T20:01:00.000Z",
            },
          ],
          localReadThroughSequence: null,
          error: null,
        },
        reactions: [
          {
            eventId: "reaction-1",
            participantId: "participant-1",
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
        messages: [
          expect.objectContaining({
            id: "message-1",
            sequence: "1",
            senderId: "participant-1",
            content: "Hello",
            attachments: [expect.objectContaining({ attachmentId: "attachment-image", fileName: "diagram.png" }), expect.objectContaining({ attachmentId: "attachment-file", fileName: "notes.pdf" })],
            readBy: [expect.objectContaining({ participantId: "participant-2", displayName: "Grace" })],
          }),
        ],
        reactions: [expect.objectContaining({ id: "reaction-1", emoji: "🎉", participantName: "Ada" })],
      }),
    );
  });

  it("delegates chat, reaction, and directed media actions to the injected canonical store", async () => {
    const store = actionStore();
    const commands = createNativeActionCommands(store);

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
    const commands = createNativeActionCommands(store);
    const reportFailure = vi.fn();
    const prompt = createNativeMediaRequestPrompt(
      {
        requestId: "request-1",
        kind: "start_camera",
        actorParticipantId: "host-1",
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

function actionStore(): SpaceClientStore {
  return {
    sendChatMessage: vi.fn(() => Promise.resolve()),
    sendReaction: vi.fn(() => Promise.resolve()),
    requestUnmute: vi.fn(() => Promise.resolve()),
    requestStartCamera: vi.fn(() => Promise.resolve()),
    muteParticipant: vi.fn(() => Promise.resolve()),
    stopParticipantCamera: vi.fn(() => Promise.resolve()),
    removeParticipant: vi.fn(() => Promise.resolve()),
    acceptMediaRequest: vi.fn(() => Promise.resolve()),
    declineMediaRequest: vi.fn(() => Promise.resolve()),
  } as unknown as SpaceClientStore;
}

function snapshot(overrides: Partial<NativeSpaceSnapshot>): NativeSpaceSnapshot {
  return {
    actions: { phase: "disabled", version: null, capabilities: [], error: null },
    chat: {
      status: "idle",
      messages: [],
      pending: [],
      hasOlder: false,
      historyTruncated: false,
      retainedFloorSequence: null,
      unreadCount: 0,
      readReceipts: [],
      localReadThroughSequence: null,
      error: null,
    },
    reactions: [],
    incomingMediaRequests: [],
    ...overrides,
  } as NativeSpaceSnapshot;
}
