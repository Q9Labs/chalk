import { describe, expect, it } from "bun:test";
import { EventEmitter } from "../events";
import { createConferenceSessionAnnotationActions } from "../conference-session/annotation-actions";

class MockWSClient extends EventEmitter<{ connected: void }> {
  connectionState: "connecting" | "connected" | "reconnecting" | "disconnected" | "failed" = "connecting";
  startCalls: Array<{ shareSessionId: string; sharerParticipantId: string; accessMode: "all" | "sharer_only" | "off" }> = [];
  syncCalls: Array<string | undefined> = [];

  sendAnnotationSessionStart(payload: { shareSessionId: string; sharerParticipantId: string; accessMode: "all" | "sharer_only" | "off" }): void {
    this.startCalls.push(payload);
  }

  requestAnnotationSync(shareSessionId?: string): void {
    this.syncCalls.push(shareSessionId);
  }

  connect(): void {
    this.connectionState = "connected";
    this.emit("connected", undefined);
  }
}

describe("createConferenceSessionAnnotationActions", () => {
  it("queues annotation session start until websocket is connected", () => {
    const wsClient = new MockWSClient();
    const actions = createConferenceSessionAnnotationActions({
      getWsClient: () => wsClient as never,
      getLocalParticipant: () => ({
        id: "local-participant",
        displayName: "Local",
        role: "host",
        isLocal: true,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: true,
        handRaised: false,
        connectionQuality: 100,
      }),
      getCurrentAccessMode: () => "all",
      getCurrentShareSessionId: () => "share-1",
      getCurrentSharerParticipantId: () => "local-participant",
    });

    actions.startAnnotationSession("share-queued", "all");

    expect(wsClient.startCalls).toEqual([]);

    wsClient.connect();

    expect(wsClient.startCalls).toEqual([
      {
        shareSessionId: "share-queued",
        sharerParticipantId: "local-participant",
        accessMode: "all",
      },
    ]);
  });

  it("skips annotation sync while websocket is not connected", () => {
    const wsClient = new MockWSClient();
    const actions = createConferenceSessionAnnotationActions({
      getWsClient: () => wsClient as never,
      getLocalParticipant: () => ({
        id: "local-participant",
        displayName: "Local",
        role: "host",
        isLocal: true,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: true,
        handRaised: false,
        connectionQuality: 100,
      }),
      getCurrentAccessMode: () => "all",
      getCurrentShareSessionId: () => "share-queued",
      getCurrentSharerParticipantId: () => "local-participant",
    });

    actions.requestAnnotationSync();
    expect(wsClient.syncCalls).toEqual([]);

    wsClient.connect();
    actions.requestAnnotationSync();
    expect(wsClient.syncCalls).toEqual(["share-queued"]);
  });
});
