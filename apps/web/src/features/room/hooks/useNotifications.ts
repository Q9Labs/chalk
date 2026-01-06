/**
 * useNotifications - Notification management hook
 *
 * Manages: notification queue, unread message tracking, chat notifications
 * Provides: add/dismiss notifications with logging
 */

import type { Notification } from "@q9labs/chalk-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("useNotifications");

interface UseNotificationsOptions {
	messages: Array<{
		id: string;
		senderId: string;
		senderName: string;
		content: string;
	}>;
	localParticipantId: string | undefined;
	activePanel: "chat" | "info" | "participants" | null;
}

export interface NotificationsState {
	notifications: Notification[];
	unreadCount: number;
	addNotification: (message: string, type?: Notification["type"]) => void;
	dismissNotification: (id: string) => void;
}

export function useNotifications({
	messages,
	localParticipantId,
	activePanel,
}: UseNotificationsOptions): NotificationsState {
	const [notifications, setNotifications] = useState<Notification[]>([]);
	const [unreadCount, setUnreadCount] = useState(0);
	const lastMessageCountRef = useRef(0);

	// ==========================================================================
	// LIFECYCLE
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		log.debug("Initial State", {
			messageCount: messages.length,
			localParticipantId,
			activePanel,
		});

		return () => {
			log.lifecycle("unmount");
			log.debug("Final State", {
				notificationCount: notifications.length,
				unreadCount,
			});
		};
	}, []);

	// ==========================================================================
	// MESSAGE TRACKING
	// ==========================================================================

	useEffect(() => {
		const currentCount = messages.length;
		const previousCount = lastMessageCountRef.current;

		log.debug("Message Check", {
			previousCount,
			currentCount,
			activePanel,
			localParticipantId,
		});

		if (currentCount > previousCount) {
			const newMessages = messages.slice(previousCount);

			log.info("receive", `${newMessages.length} new message(s) received`, "event");

			for (const msg of newMessages) {
				const isLocal = msg.senderId === localParticipantId;

				log.debug("New Message", {
					id: msg.id,
					senderId: msg.senderId,
					senderName: msg.senderName,
					isLocal,
					contentPreview: msg.content.substring(0, 30) + (msg.content.length > 30 ? "..." : ""),
					chatPanelOpen: activePanel === "chat",
				});

				// Only notify for messages from others
				if (!isLocal) {
					if (activePanel !== "chat") {
						log.info("notification", `New message from ${msg.senderName}`, "event");

						setUnreadCount((prev) => {
							const newCount = prev + 1;
							log.stateChange("unreadCount", prev, newCount);
							return newCount;
						});

						// Show notification
						const id = `msg-${Date.now()}`;
						const notifMessage = `${msg.senderName}: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? "..." : ""}`;

						log.debug("Creating Notification", {
							id,
							message: notifMessage,
							type: "info",
						});

						setNotifications((prev) => [
							...prev,
							{
								id,
								message: notifMessage,
								type: "info" as const,
								duration: 4000,
							},
						]);
					} else {
						log.info("info", `Message from ${msg.senderName} (chat open, no notification)`, "state");
					}
				} else {
					log.info("info", "Local message sent, no notification needed", "state");
				}
			}
		}

		lastMessageCountRef.current = currentCount;
	}, [messages, activePanel, localParticipantId]);

	// ==========================================================================
	// CLEAR UNREAD ON CHAT OPEN
	// ==========================================================================

	useEffect(() => {
		if (activePanel === "chat" && unreadCount > 0) {
			log.action("click", "Chat panel opened, clearing unread count", `was: ${unreadCount}`);
			setUnreadCount(0);
		}
	}, [activePanel, unreadCount]);

	// ==========================================================================
	// ACTIONS
	// ==========================================================================

	const addNotification = useCallback(
		(message: string, type: Notification["type"] = "info") => {
			const id = `notif-${Date.now()}`;

			log.action("notification", "Adding notification", `type=${type}`);
			log.debug("Notification Details", {
				id,
				message,
				type,
				duration: 4000,
			});

			setNotifications((prev) => {
				const newNotifications = [
					...prev,
					{ id, message, type, duration: 4000 },
				];
				log.debug("Notifications Queue", {
					count: newNotifications.length,
					ids: newNotifications.map(n => n.id),
				});
				return newNotifications;
			});
		},
		[]
	);

	const dismissNotification = useCallback((id: string) => {
		log.action("click", "Dismissing notification", id);

		setNotifications((prev) => {
			const notification = prev.find(n => n.id === id);
			if (notification) {
				log.debug("Dismissed Notification", {
					id,
					message: notification.message,
					type: notification.type,
				});
			}
			return prev.filter((n) => n.id !== id);
		});
	}, []);

	// ==========================================================================
	// DEBUG: Log notification changes
	// ==========================================================================

	useEffect(() => {
		log.debug("Notifications State Changed", {
			count: notifications.length,
			notifications: notifications.map(n => ({
				id: n.id,
				type: n.type,
				message: n.message.substring(0, 30),
			})),
		});
	}, [notifications]);

	useEffect(() => {
		log.debug("Unread Count Changed", { unreadCount });
	}, [unreadCount]);

	return {
		notifications,
		unreadCount,
		addNotification,
		dismissNotification,
	};
}
