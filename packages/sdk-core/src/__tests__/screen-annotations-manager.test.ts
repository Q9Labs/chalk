import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { ScreenAnnotationsManager } from "../managers/screen-annotations-manager";

type AnnotationAccessMode = "all" | "sharer_only" | "off";

class MockRoom extends EventEmitter {
  public localParticipant = {
    id: "local",
    role: "host" as const,
  };
  public startCalls: Array<{
    shareSessionId: string;
    accessMode: AnnotationAccessMode;
  }> = [];
  private annotationSharerParticipantId: string | null = null;
  private annotationAccessMode: AnnotationAccessMode = "all";

  canDrawAnnotations(participantId?: string): boolean {
    const resolvedParticipantId = participantId ?? this.localParticipant?.id ?? null;
    if (!resolvedParticipantId) {
      return false;
    }

    if (this.annotationAccessMode === "off") {
      return false;
    }

    if (this.annotationAccessMode === "all") {
      return true;
    }

    return this.annotationSharerParticipantId === resolvedParticipantId;
  }

  startAnnotationSession(
    shareSessionId: string,
    accessMode: AnnotationAccessMode = "all",
  ): void {
    this.startCalls.push({ shareSessionId, accessMode });
  }

  _setAnnotationSession(
    shareSessionId: string | null,
    sharerParticipantId: string | null,
  ): void {
    void shareSessionId;
    this.annotationSharerParticipantId = sharerParticipantId;
  }

  _setAnnotationAccessMode(accessMode: AnnotationAccessMode): void {
    this.annotationAccessMode = accessMode;
  }
}

describe("ScreenAnnotationsManager", () => {
  it("activates the local sharer session immediately before the server echo", () => {
    const room = new MockRoom();
    const manager = new ScreenAnnotationsManager();
    manager.attachRoom(room as any);

    manager.startSession("share-1", "local", "all");

    expect(room.startCalls).toEqual([
      {
        shareSessionId: "share-1",
        accessMode: "all",
      },
    ]);
    expect(manager.getState()).toMatchObject({
      shareSessionId: "share-1",
      sharerParticipantId: "local",
      accessMode: "all",
      isSessionActive: true,
      canDraw: true,
    });
  });

  it("keeps the local sharer drawable for sharer-only sessions before the echo", () => {
    const room = new MockRoom();
    const manager = new ScreenAnnotationsManager();
    manager.attachRoom(room as any);

    manager.startSession("share-2", "local", "sharer_only");

    expect(manager.getState()).toMatchObject({
      shareSessionId: "share-2",
      sharerParticipantId: "local",
      accessMode: "sharer_only",
      isSessionActive: true,
      canDraw: true,
    });
  });

  it("keeps the toolbar open when a late session-ended arrives during sync", () => {
    const room = new MockRoom();
    const manager = new ScreenAnnotationsManager();
    manager.attachRoom(room as any);

    manager.open();
    room.emit("annotation.session.ended", {
      shareSessionId: "",
      endedAt: new Date(),
    });

    expect(manager.getState()).toMatchObject({
      isOpen: true,
      isSessionActive: false,
      canDraw: false,
    });
  });
});
