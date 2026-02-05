import { WSClientBase } from "./base.ts";

export { type WSClientOptions } from "./deps.ts";

export class WSClient extends WSClientBase {
	// Client-to-server actions
	sendChatMessage(content: string): void {
		this.send({ type: "chat.send", payload: { content } });
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
	sendWhiteboardUpdate(
		elements: unknown[],
		files?: Record<string, unknown>,
		seq?: number,
	): void {
		this.send({
			type: "whiteboard.update",
			payload: { elements, files, seq: seq ?? this.now() },
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

	sendTranscript(transcript: {
		id: string;
		participantId: string;
		speakerName: string;
		text: string;
		timestamp: Date;
		isInterim?: boolean;
		confidence?: number;
	}): void {
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
