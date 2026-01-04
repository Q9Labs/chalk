/**
 * useChat hook - Chat functionality
 */

import type { ChatMessage } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

export interface UseChatResult {
	messages: ChatMessage[];
	sendMessage: (content: string) => void;
}

export function useChat(): UseChatResult {
	const { room } = useChalk();
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	useEffect(() => {
		console.log("[useChat] Effect running, room:", room ? "exists" : "null");
		if (!room) {
			setMessages([]);
			return;
		}

		// Initialize with existing messages
		console.log("[useChat] Initializing with", room.messages.length, "existing messages");
		setMessages(room.messages);

		const unsub = room.on("chat-message", (message) => {
			console.log("[useChat] Received chat-message event:", message);
			setMessages((prev) => {
				console.log("[useChat] Updating messages, prev:", prev.length, "new total:", prev.length + 1);
				return [...prev, message];
			});
		});

		return unsub;
	}, [room]);

	const sendMessage = useCallback(
		(content: string) => {
			console.log("[useChat] sendMessage called:", content, "room:", room ? "exists" : "null");
			if (room) {
				room.sendMessage(content);
			} else {
				console.log("[useChat] Cannot send - no room!");
			}
		},
		[room],
	);

	return {
		messages,
		sendMessage,
	};
}
