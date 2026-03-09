import { WSClientBase } from "./base.ts";

export { type WSClientOptions } from "./deps.ts";

export class WSClient extends WSClientBase {
  // Client-to-server actions
  requestRoomSync(lastSeq?: number): void {
    this.send({ type: "room.sync", payload: { lastSeq: lastSeq ?? this.now() } });
  }

  sendChatMessage(content: string, attachmentIds?: string[]): void {
    this.send({
      type: "chat.send",
      payload: attachmentIds && attachmentIds.length > 0 ? { content, attachmentIds } : { content },
    });
  }

  sendChatRead(readThroughMessageId: string): void {
    this.send({ type: "chat.read", payload: { readThroughMessageId } });
  }

  sendReaction(emoji: string): void {
    this.send({ type: "reaction.send", payload: { emoji } });
  }

  raiseHand(): void {
    this.send({ type: "hand.raise" });
  }

  lowerHand(): void {
    this.send({ type: "hand.lower" });
  }

  muteParticipant(participantId: string): void {
    this.send({ type: "participant.mute", payload: { participantId } });
  }

  unmuteParticipant(participantId: string): void {
    this.send({ type: "participant.unmute", payload: { participantId } });
  }

  // Whiteboard methods
  sendWhiteboardUpdateV2(payload: { sceneId: string; syncAll: boolean; elements: unknown[]; seq?: number }): void {
    this.send({
      type: "whiteboard.update",
      payload: {
        schemaVersion: 2,
        sceneId: payload.sceneId,
        syncAll: payload.syncAll,
        elements: payload.elements,
        seq: payload.seq ?? this.now(),
      },
    });
  }

  sendWhiteboardCursor(x: number, y: number): void {
    this.send({ type: "whiteboard.cursor", payload: { x, y } });
  }

  sendWhiteboardClear(): void {
    this.send({ type: "whiteboard.clear" });
  }

  requestWhiteboardSync(): void {
    this.send({ type: "whiteboard.sync" });
  }

  grantWhiteboardPermission(participantId: string): void {
    this.send({
      type: "permission.grant",
      payload: { participantId, feature: "whiteboard" },
    });
  }

  revokeWhiteboardPermission(participantId: string): void {
    this.send({
      type: "permission.revoke",
      payload: { participantId, feature: "whiteboard" },
    });
  }

  sendWhiteboardOpen(): void {
    this.send({ type: "whiteboard.open" });
  }

  sendWhiteboardClose(): void {
    this.send({ type: "whiteboard.close" });
  }

  sendAnnotationSessionStart(payload: { shareSessionId: string; sharerParticipantId: string; accessMode: "all" | "sharer_only" | "off" }): void {
    this.send({ type: "annotation.session.start", payload });
  }

  sendAnnotationSessionEnd(payload: { shareSessionId: string }): void {
    this.send({ type: "annotation.session.end", payload });
  }

  requestAnnotationSync(shareSessionId?: string): void {
    this.send({
      type: "annotation.sync",
      payload: shareSessionId ? { shareSessionId } : {},
    });
  }

  sendAnnotationUpdate(payload: { shareSessionId: string; sharerParticipantId: string; syncAll: boolean; items: unknown[]; seq?: number }): void {
    this.send({
      type: "annotation.update",
      payload: {
        shareSessionId: payload.shareSessionId,
        sharerParticipantId: payload.sharerParticipantId,
        syncAll: payload.syncAll,
        items: payload.items,
        seq: payload.seq ?? this.now(),
      },
    });
  }

  clearAnnotations(payload: { shareSessionId: string }): void {
    this.send({ type: "annotation.clear", payload });
  }

  sendAnnotationCursor(payload: { shareSessionId: string; tool: "pen" | "highlighter" | "rectangle" | "ellipse" | "line" | "arrow" | "text"; x: number; y: number }): void {
    this.send({ type: "annotation.cursor", payload });
  }

  setAnnotationAccessMode(payload: { shareSessionId: string; accessMode: "all" | "sharer_only" | "off" }): void {
    this.send({ type: "annotation.access.set", payload });
  }

  sendTranscript(transcript: { id: string; participantId: string; speakerName: string; text: string; timestamp: Date; isInterim?: boolean; confidence?: number }): void {
    if (transcript.isInterim) return;
    this.send({
      type: "transcript",
      payload: {
        id: transcript.id,
        participantId: transcript.participantId,
        speakerName: transcript.speakerName,
        text: transcript.text,
        timestamp: transcript.timestamp.toISOString(),
        isInterim: transcript.isInterim,
        confidence: transcript.confidence,
      },
    });
  }
}
