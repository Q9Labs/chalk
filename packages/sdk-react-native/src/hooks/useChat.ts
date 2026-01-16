/**
 * useChat hook - Chat messaging functionality
 * Note: Chat requires WebSocket integration (not yet implemented in RN SDK)
 */

import type { ChatMessage } from "@q9labs/chalk-core";
import { useCallback, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface UseChatResult {
	messages: ChatMessage[];
	sendMessage: (content: string) => void;
}

export function useChat(): UseChatResult {
	const { roomInfo } = useChalk();
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	const sendMessage = useCallback(
		(content: string) => {
			if (!roomInfo) return;

			// TODO: Implement WebSocket chat
			// For now, add message to local state only
			const localMessage: ChatMessage = {
				id: `local-${Date.now()}`,
				senderId: roomInfo.participantId,
				senderName: "You",
				content,
				timestamp: new Date(),
			};
			setMessages((prev) => [...prev, localMessage]);
		},
		[roomInfo],
	);

	return {
		messages,
		sendMessage,
	};
}
