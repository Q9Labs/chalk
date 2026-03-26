import { wideEvents } from "../wide-events/index.ts";
import { WSClientBase } from "./base.ts";

export { type WSClientOptions } from "./deps.ts";

export class WSClient extends WSClientBase {
  private emitActionWideEvent(eventType: "reaction.send" | "hand.raise" | "hand.lower" | "participant.mute.request" | "participant.unmute.request", details: Record<string, unknown>): boolean {
    const ctx = wideEvents.start(eventType);
    ctx.merge(details);

    if (this.connectionState !== "connected") {
      ctx.complete("error", {
        code: "WS_NOT_CONNECTED",
        message: "WebSocket not connected",
      });
      return false;
    }

    ctx.complete("success");
    return true;
  }

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
    if (!this.emitActionWideEvent("reaction.send", { emoji })) {
      return;
    }
    this.send({ type: "reaction.send", payload: { emoji } });
  }

  raiseHand(): void {
    if (!this.emitActionWideEvent("hand.raise", {})) {
      return;
    }
    this.send({ type: "hand.raise" });
  }

  lowerHand(): void {
    if (!this.emitActionWideEvent("hand.lower", {})) {
      return;
    }
    this.send({ type: "hand.lower" });
  }

  muteParticipant(participantId: string): void {
    if (!this.emitActionWideEvent("participant.mute.request", { participantId })) {
      return;
    }
    this.send({ type: "participant.mute", payload: { participantId } });
  }

  unmuteParticipant(participantId: string): void {
    if (!this.emitActionWideEvent("participant.unmute.request", { participantId })) {
      return;
    }
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
