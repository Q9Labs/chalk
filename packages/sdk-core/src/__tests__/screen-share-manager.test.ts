import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { ScreenShareManager } from "../managers/screen-share-manager";

type ParticipantLike = {
  id: string;
  isLocal: boolean;
  isScreenSharing: boolean;
  screenShareTrack?: MediaStreamTrack;
  screenShareAudioTrack?: MediaStreamTrack;
};

class MockRoom extends EventEmitter {
  public localParticipant: ParticipantLike | null;
  public participants = new Map<string, ParticipantLike>();
  public stopCalled = false;
  private readonly emitParticipantUpdatedOnStart: boolean;
  private readonly startResult: boolean;

  constructor(localParticipant: ParticipantLike, options?: { emitParticipantUpdatedOnStart?: boolean; startResult?: boolean }) {
    super();
    this.localParticipant = localParticipant;
    this.participants.set(localParticipant.id, localParticipant);
    this.emitParticipantUpdatedOnStart = options?.emitParticipantUpdatedOnStart ?? false;
    this.startResult = options?.startResult ?? true;
  }

  async startScreenShare(): Promise<boolean> {
    if (!this.localParticipant || !this.startResult) return false;
    this.localParticipant.isScreenSharing = true;
    if (this.emitParticipantUpdatedOnStart) {
      this.emit("participant.updated", {
        participantId: this.localParticipant.id,
        participant: this.localParticipant,
      });
    }
    return true;
  }

  async stopScreenShare(): Promise<void> {
    this.stopCalled = true;
    if (this.localParticipant) {
      this.localParticipant.isScreenSharing = false;
    }
  }
}

describe("ScreenShareManager", () => {
  it("keeps local sharing true even if local participant id changes", async () => {
    const room = new MockRoom({
      id: "A",
      isLocal: true,
      isScreenSharing: false,
    });

    const manager = new ScreenShareManager();
    manager.attachRoom(room as any);

    const started = await manager.start();
    expect(started).toBe(true);
    expect(manager.isLocalSharing).toBe(true);

    // Simulate stable participant id change mid-session (e.g. mapping peerId -> userId).
    room.localParticipant!.id = "B";

    // Local-sharing should remain true and stop should still work.
    expect(manager.isLocalSharing).toBe(true);
    await manager.stop();
    expect(room.stopCalled).toBe(true);
  });

  it("does not allow stopping when remote participant is sharing", async () => {
    const room = new MockRoom({
      id: "local",
      isLocal: true,
      isScreenSharing: false,
    });

    const manager = new ScreenShareManager();
    manager.attachRoom(room as any);

    // Remote starts sharing (via participant.updated event).
    const remote: ParticipantLike = {
      id: "remote",
      isLocal: false,
      isScreenSharing: true,
    };
    room.participants.set(remote.id, remote);
    room.emit("participant.updated", { participantId: remote.id, participant: remote });

    expect(manager.isLocalSharing).toBe(false);
    await manager.stop();
    expect(room.stopCalled).toBe(false);
  });

  it("does not emit duplicate started events when the room updates local sharing during start", async () => {
    const room = new MockRoom(
      {
        id: "local",
        isLocal: true,
        isScreenSharing: false,
      },
      { emitParticipantUpdatedOnStart: true },
    );

    const manager = new ScreenShareManager();
    manager.attachRoom(room as any);

    const startedEvents: Array<{ participantId: string; isLocal: boolean }> = [];
    manager.on("started", (event) => {
      startedEvents.push(event);
    });

    const started = await manager.start();

    expect(started).toBe(true);
    expect(startedEvents).toEqual([
      {
        participantId: "local",
        isLocal: true,
      },
    ]);
    expect(manager.getState()).toMatchObject({
      isActive: true,
      isStarting: false,
      isLocalSharer: true,
      sharerParticipantId: "local",
    });
  });

  it("does not emit a second generic error when the room already failed screen-share start", async () => {
    const room = new MockRoom(
      {
        id: "local",
        isLocal: true,
        isScreenSharing: false,
      },
      { startResult: false },
    );

    const manager = new ScreenShareManager();
    manager.attachRoom(room as any);

    const errors: unknown[] = [];
    manager.on("error", (error) => {
      errors.push(error);
    });

    const started = await manager.start();

    expect(started).toBe(false);
    expect(errors).toEqual([]);
    expect(manager.getState()).toMatchObject({
      isActive: false,
      isStarting: false,
      isLocalSharer: false,
    });
  });
});
