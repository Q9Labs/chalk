/**
 * useChat hook - Chat functionality
 */

import type { ChatMessage } from "@q9labs/chalk-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChalk } from "../context.tsx";

export interface UseChatResult {
	messages: ChatMessage[];
	sendMessage: (content: string) => void;
}

export function useChat(): UseChatResult {
	const { room } = useChalk();
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	// Track the room we're subscribed to (by reference, not just ID)
	const subscribedRoomRef = useRef<typeof room>(null);

	useEffect(() => {
		// If no room, cleanup
		if (!room) {
			if (subscribedRoomRef.current) {
				console.log("[useChat] Room gone - clearing messages");
				subscribedRoomRef.current = null;
				setMessages([]);
			}
			return;
		}

		// If already subscribed to THIS room instance, skip
		if (subscribedRoomRef.current === room) {
			return;
		}

		// New room - initialize
		console.log("[useChat] Subscribing to room:", room.id);
		subscribedRoomRef.current = room;

		// Set initial messages from room
		setMessages(room.messages ?? []);

		// Attach listener for new messages
		const handler = (message: ChatMessage) => {
			console.log("[useChat] Received message:", message.id, message.content);
			setMessages((prev) => [...prev, message]);
		};

		const unsubscribe = room.on("chat-message", handler);

		return () => {
			console.log("[useChat] Cleanup - unsubscribing");
			unsubscribe();
			subscribedRoomRef.current = null;
		};
	}, [room]); // Depend on room object

	const sendMessage = useCallback(
		(content: string) => {
			console.log("[useChat] Sending message:", content);
			room?.sendMessage(content);
		},
		[room],
	);

	return { messages, sendMessage };
}
