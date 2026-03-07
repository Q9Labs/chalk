import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { ChatManager } from "../managers/chat-manager";
import { InteractionManager } from "../managers/interaction-manager";
import { RecordingManager } from "../managers/recording-manager";
import { ScreenShareManager } from "../managers/screen-share-manager";
import { WhiteboardManager } from "../managers/whiteboard-manager";

type Listener = (...args: unknown[]) => void;

class MockRoom {
  public readonly emitter = new EventEmitter();
  public messages: Array<{
    id: string;
    content: string;
    senderId: string;
    senderName: string;
    timestamp: Date;
  }> = [];
  public isRecording = false;
  public localParticipant: {
    id: string;
    isLocal: boolean;
    displayName: string;
    handRaised?: boolean;
    isScreenSharing?: boolean;
    screenShareTrack?: MediaStreamTrack;
    screenShareAudioTrack?: MediaStreamTrack;
  } | null = {
    id: "local",
    isLocal: true,
    displayName: "Local",
    handRaised: false,
    isScreenSharing: false,
  };
  public participants = new Map<
    string,
    {
      id: string;
      isLocal: boolean;
      displayName: string;
      handRaised?: boolean;
      isScreenSharing?: boolean;
      screenShareTrack?: MediaStreamTrack;
      screenShareAudioTrack?: MediaStreamTrack;
    }
  >([
    [
      "local",
      {
        id: "local",
        isLocal: true,
        displayName: "Local",
        handRaised: false,
        isScreenSharing: false,
      },
    ],
  ]);

  on(event: string, listener: Listener): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitter.emit(event, payload);
  }

  canDrawWhiteboard(): boolean {
    return true;
  }
}

describe("Manager teardown listeners", () => {
  it("ChatManager does not duplicate listeners across re-attach", () => {
    const room = new MockRoom();
    const manager = new ChatManager();
    let received = 0;

    manager.on("message", () => {
      received += 1;
    });

    manager.attachRoom(room as any);
    manager.attachRoom(room as any);

    room.emit("chat.message", {
      id: "m1",
      senderId: "p1",
      senderName: "P1",
      content: "hello",
      timestamp: new Date(),
    });

    expect(received).toBe(1);
    expect(manager.getState().count).toBe(1);
  });

  it("RecordingManager does not duplicate listeners across re-attach", () => {
    const room = new MockRoom();
    const manager = new RecordingManager();
    let startedCount = 0;

    manager.on("started", () => {
      startedCount += 1;
    });

    manager.attachRoom(room as any);
    manager.attachRoom(room as any);

    room.emit("recording.started", { recordingId: "rec-1" });

    expect(startedCount).toBe(1);
    expect(manager.getState().isRecording).toBe(true);
  });

  it("InteractionManager does not duplicate listeners across re-attach", () => {
    const room = new MockRoom();
    const manager = new InteractionManager();
    let raisedCount = 0;

    manager.on("hand:raised", () => {
      raisedCount += 1;
    });

    manager.attachRoom(room as any);
    manager.attachRoom(room as any);

    room.emit("hand.raised", { participantId: "p1" });

    expect(raisedCount).toBe(1);
    expect(manager.getState().raisedHands).toContain("p1");
  });

  it("ScreenShareManager does not duplicate listeners across re-attach", () => {
    const room = new MockRoom();
    const manager = new ScreenShareManager();
    let startedCount = 0;

    manager.on("started", () => {
      startedCount += 1;
    });

    manager.attachRoom(room as any);
    manager.attachRoom(room as any);

    const remote = {
      id: "remote",
      isLocal: false,
      displayName: "Remote",
      isScreenSharing: true,
    };
    room.participants.set(remote.id, remote);
    room.emit("participant.updated", {
      participantId: remote.id,
      participant: remote,
    });

    expect(startedCount).toBe(1);
    expect(manager.getState().isActive).toBe(true);
    expect(manager.getState().sharerParticipantId).toBe("remote");
  });

  it("WhiteboardManager does not duplicate listeners across re-attach", () => {
    const room = new MockRoom();
    const manager = new WhiteboardManager();
    let openedCount = 0;

    manager.on("opened", () => {
      openedCount += 1;
    });

    manager.attachRoom(room as any);
    manager.attachRoom(room as any);

    room.emit("whiteboard.opened", {
      participantId: "remote",
      displayName: "Remote",
    });

    expect(openedCount).toBe(1);
    expect(manager.getState().isOpen).toBe(true);
  });
});
