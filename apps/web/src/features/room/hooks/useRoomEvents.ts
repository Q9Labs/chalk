/**
 * useRoomEvents - Room event handling hook
 *
 * Manages: reactions, hand raises, participant events
 * Provides: event handlers with full logging
 */

import type { Reaction } from "@q9labs/chalk-core";
import type { Notification } from "@q9labs/chalk-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("useRoomEvents");

interface UseRoomEventsOptions {
	room: any; // Room instance from SDK
	localParticipantId: string | undefined;
	participants: Array<{ id: string; displayName: string }>;
	onNotification: (notification: Omit<Notification, "id">) => void;
}

interface ActiveReaction {
	id: string;
	emoji: string;
	participantName: string;
}

export interface RoomEventsState {
	// Reactions
	activeReactions: ActiveReaction[];
	isReactionPickerOpen: boolean;
	setIsReactionPickerOpen: (open: boolean) => void;
	handleSendReaction: (emoji: string) => void;

	// Hand raise
	isHandRaised: boolean;
	handleHandRaise: () => void;
}

export function useRoomEvents({
	room,
	localParticipantId,
	participants,
	onNotification,
}: UseRoomEventsOptions): RoomEventsState {
	// State
	const [activeReactions, setActiveReactions] = useState<ActiveReaction[]>([]);
	const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
	const [isHandRaised, setIsHandRaised] = useState(false);

	// Refs to avoid effect re-runs (access latest values without adding to deps)
	const participantsRef = useRef(participants);
	const onNotificationRef = useRef(onNotification);

	// Keep refs updated
	useEffect(() => {
		participantsRef.current = participants;
	}, [participants]);

	useEffect(() => {
		onNotificationRef.current = onNotification;
	}, [onNotification]);

	// ==========================================================================
	// LIFECYCLE
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		log.debug("Initial State", {
			hasRoom: !!room,
			localParticipantId,
			participantCount: participants.length,
		});

		return () => {
			log.lifecycle("unmount");
		};
	}, []);

	// ==========================================================================
	// REACTION EVENTS
	// ==========================================================================

	useEffect(() => {
		if (!room) {
			log.warn("reaction-listener", "No room instance, skipping reaction listener setup");
			return;
		}

		log.lifecycle("effect", "reaction-listener-setup");

		const handleReaction = (reaction: Reaction) => {
			const isLocal = reaction.participantId === localParticipantId;

			log.event("reaction", `${reaction.emoji} from ${reaction.participantName}`, isLocal ? "local" : "remote");
			log.debug("Reaction Details", {
				emoji: reaction.emoji,
				participantId: reaction.participantId,
				participantName: reaction.participantName,
				isLocal,
				timestamp: Date.now(),
			});

			// Don't show local reactions again (we show them immediately when sent)
			if (isLocal) {
				log.info("info", "Skipping local reaction display (already shown)", "state");
				return;
			}

			const id = `${reaction.participantId}-${Date.now()}`;
			setActiveReactions((prev) => {
				const newReactions = [
					...prev,
					{
						id,
						emoji: reaction.emoji,
						participantName: reaction.participantName,
					},
				];
				log.debug("Active Reactions", {
					count: newReactions.length,
					reactions: newReactions.map(r => `${r.emoji}(${r.participantName})`),
				});
				return newReactions;
			});

			// Auto-remove after animation
			setTimeout(() => {
				log.info("info", `Removing reaction: ${reaction.emoji}`, "state");
				setActiveReactions((prev) => prev.filter((r) => r.id !== id));
			}, 2500);
		};

		room.on("reaction", handleReaction);
		log.info("success", "Reaction listener attached", "lifecycle");

		return () => {
			log.lifecycle("cleanup", "reaction-listener");
			room.off("reaction", handleReaction);
		};
	}, [room, localParticipantId]);

	// ==========================================================================
	// HAND RAISE EVENTS
	// ==========================================================================

	useEffect(() => {
		if (!room) {
			log.warn("hand-raise-listener", "No room instance, skipping hand raise listener setup");
			return;
		}

		log.lifecycle("effect", "hand-raise-listener-setup");

		const handleHandRaised = (data: { participantId: string }) => {
			const isLocal = data.participantId === localParticipantId;

			log.event("hand", `Hand raised by participant`, `id=${data.participantId}, isLocal=${isLocal}`);

			if (!isLocal) {
				// Use ref to get latest participants without causing effect re-runs
				const participant = participantsRef.current.find((p) => p.id === data.participantId);
				const name = participant?.displayName || "Someone";

				log.info("hand", `${name} raised their hand`, "event");
				log.debug("Hand Raise Details", {
					participantId: data.participantId,
					participantName: name,
					totalParticipants: participantsRef.current.length,
				});

				// Use ref to get latest callback
				onNotificationRef.current({
					message: `${name} raised their hand`,
					type: "info",
					duration: 4000,
				});
			}
		};

		const handleHandLowered = (data: { participantId: string }) => {
			const isLocal = data.participantId === localParticipantId;
			log.event("hand", `Hand lowered by participant`, `id=${data.participantId}, isLocal=${isLocal}`);
		};

		room.on("hand-raised", handleHandRaised);
		room.on("hand-lowered", handleHandLowered);
		log.info("success", "Hand raise listeners attached", "lifecycle");

		return () => {
			log.lifecycle("cleanup", "hand-raise-listeners");
			room.off("hand-raised", handleHandRaised);
			room.off("hand-lowered", handleHandLowered);
		};
	}, [room, localParticipantId]); // Removed participants and onNotification - using refs instead

	// ==========================================================================
	// ACTIONS
	// ==========================================================================

	const handleSendReaction = useCallback(
		(emoji: string) => {
			log.action("reaction", "Sending reaction", emoji);

			if (room) {
				log.sdk("room.sendReaction", { emoji });
				room.sendReaction(emoji as any);

				// Show own reaction locally immediately
				const id = `local-${Date.now()}`;
				log.info("reaction", `Local reaction displayed: ${emoji}`, "state");

				setActiveReactions((prev) => [
					...prev,
					{ id, emoji, participantName: "You" },
				]);

				setTimeout(() => {
					log.info("info", `Removing local reaction: ${emoji}`, "state");
					setActiveReactions((prev) => prev.filter((r) => r.id !== id));
				}, 2500);
			} else {
				log.warn("handleSendReaction", "Cannot send reaction - no room instance");
			}

			setIsReactionPickerOpen(false);
		},
		[room]
	);

	const handleHandRaise = useCallback(() => {
		log.action("hand", isHandRaised ? "Lowering hand" : "Raising hand");

		if (room) {
			if (isHandRaised) {
				log.sdk("room.lowerHand");
				room.lowerHand();
			} else {
				log.sdk("room.raiseHand");
				room.raiseHand();
			}
			setIsHandRaised(!isHandRaised);
			log.stateChange("isHandRaised", isHandRaised, !isHandRaised);
		} else {
			log.warn("handleHandRaise", "Cannot toggle hand - no room instance");
		}
	}, [room, isHandRaised]);

	const handleSetReactionPickerOpen = useCallback((open: boolean) => {
		log.action("toggle", "Reaction picker", open ? "open" : "closed");
		setIsReactionPickerOpen(open);
	}, []);

	return {
		activeReactions,
		isReactionPickerOpen,
		setIsReactionPickerOpen: handleSetReactionPickerOpen,
		handleSendReaction,
		isHandRaised,
		handleHandRaise,
	};
}
