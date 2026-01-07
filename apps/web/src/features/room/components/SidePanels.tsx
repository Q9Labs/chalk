/**
 * SidePanels - Chat, Participants, and Info panels
 *
 * Displays: contextual side panels based on activePanel state
 * Handles: chat messages, participant list, meeting info
 */

import { ChatPanel, ParticipantList } from "@q9labs/chalk-react";
import { X } from "lucide-react";
import { useEffect } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("SidePanels");

interface Message {
	id: string;
	senderId: string;
	senderName: string;
	content: string;
	timestamp: Date;
}

interface Participant {
	id: string;
	displayName: string;
}

interface SidePanelsProps {
	activePanel: "chat" | "info" | "participants" | null;
	onClosePanel: () => void;

	// Chat
	messages: Message[];
	onSendMessage: (message: string) => void;
	localParticipantId: string | undefined;

	// Participants
	participants: Participant[];
	isAudioEnabled: boolean;
	onRemoveParticipant: (id: string) => void;

	// Info
	roomId: string;
	sessionSeconds: number;
}

export function SidePanels({
	activePanel,
	onClosePanel,
	messages,
	onSendMessage,
	localParticipantId,
	participants,
	isAudioEnabled,
	onRemoveParticipant,
	roomId,
	sessionSeconds,
}: SidePanelsProps) {
	// ==========================================================================
	// LIFECYCLE & DEBUG
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		return () => log.lifecycle("unmount");
	}, []);

	useEffect(() => {
		if (activePanel) {
			log.info("info", `Panel opened: ${activePanel}`, "state");
			log.debug("Panel Context", {
				panel: activePanel,
				messageCount: messages.length,
				participantCount: participants.length,
			});
		} else {
			log.info("info", "All panels closed", "state");
		}
	}, [activePanel, messages.length, participants.length]);

	// ==========================================================================
	// HANDLERS
	// ==========================================================================

	const handleSendMessage = (message: string) => {
		log.action("send", "Sending chat message", `length=${message.length}`);
		log.debug("Message Content", {
			content: message.substring(0, 50) + (message.length > 50 ? "..." : ""),
			fullLength: message.length,
		});
		onSendMessage(message);
	};

	const handleRemoveParticipant = (participantId: string) => {
		const participant = participants.find(p => p.id === participantId);
		log.action("click", "Remove participant", participant?.displayName || participantId);
		onRemoveParticipant(participantId);
	};

	const handleClosePanel = () => {
		log.action("click", "Close panel", activePanel || "none");
		onClosePanel();
	};

	// ==========================================================================
	// HELPERS
	// ==========================================================================

	const formatDuration = (totalSeconds: number) => {
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		if (hours > 0) return `${hours}hr ${minutes}min ${seconds}s`;
		return `${minutes}min ${seconds}s`;
	};

	// ==========================================================================
	// RENDER
	// ==========================================================================

	if (!activePanel) {
		return null;
	}

	return (
		<div className="w-80 sm:w-96 flex-shrink-0 animate-in slide-in-from-right duration-300 relative z-20">
			{activePanel === "chat" && (
				<ChatPanelWrapper
					messages={messages}
					localParticipantId={localParticipantId}
					onSendMessage={handleSendMessage}
				/>
			)}

			{activePanel === "participants" && (
				<ParticipantsPanelWrapper
					participants={participants}
					localParticipantId={localParticipantId}
					isAudioEnabled={isAudioEnabled}
					onClose={handleClosePanel}
					onRemoveParticipant={handleRemoveParticipant}
				/>
			)}

			{activePanel === "info" && (
				<InfoPanel
					roomId={roomId}
					sessionSeconds={sessionSeconds}
					onClose={handleClosePanel}
					formatDuration={formatDuration}
				/>
			)}
		</div>
	);
}

// ==========================================================================
// SUB-COMPONENTS
// ==========================================================================

function ChatPanelWrapper({
	messages,
	localParticipantId,
	onSendMessage,
}: {
	messages: Message[];
	localParticipantId: string | undefined;
	onSendMessage: (message: string) => void;
}) {
	useEffect(() => {
		const lastMsg = messages[messages.length - 1];
		log.debug("Chat Panel State", {
			messageCount: messages.length,
			localParticipantId,
			lastMessage: lastMsg ? {
				sender: lastMsg.senderName,
				preview: lastMsg.content.substring(0, 30),
			} : null,
		});
	}, [messages, localParticipantId]);

	return (
		<div className="h-full rounded-[32px] overflow-hidden border border-border shadow-2xl ring-1 ring-border/60 bg-card">
			<ChatPanel
				messages={messages.map((msg) => ({
					...msg,
					isLocal: msg.senderId === localParticipantId,
				}))}
				onSendMessage={onSendMessage}
				className="h-full border-none"
			/>
		</div>
	);
}

function ParticipantsPanelWrapper({
	participants,
	localParticipantId,
	isAudioEnabled,
	onClose,
	onRemoveParticipant,
}: {
	participants: Participant[];
	localParticipantId: string | undefined;
	isAudioEnabled: boolean;
	onClose: () => void;
	onRemoveParticipant: (id: string) => void;
}) {
	useEffect(() => {
		log.debug("Participants Panel State", {
			count: participants.length,
			participants: participants.map(p => ({
				id: p.id.substring(0, 8),
				name: p.displayName,
				isLocal: p.id === localParticipantId,
			})),
		});
	}, [participants, localParticipantId]);

	return (
		<div className="h-full rounded-[32px] overflow-hidden border border-border shadow-2xl ring-1 ring-border/60 bg-card">
			<ParticipantList
				participants={participants.map((p) => ({
					id: p.id,
					displayName: p.displayName,
					isLocal: p.id === localParticipantId,
					isMuted: p.id === localParticipantId ? !isAudioEnabled : false,
					role: p.id === localParticipantId ? "host" : "participant",
				}))}
				onClose={onClose}
				onAddPeople={() => {
					log.action("click", "Add people (not implemented)");
				}}
				onRemoveParticipant={onRemoveParticipant}
				canManageParticipants={true}
				variant="sidebar"
				className="h-full border-none"
			/>
		</div>
	);
}

function InfoPanel({
	roomId,
	sessionSeconds,
	onClose,
	formatDuration,
}: {
	roomId: string;
	sessionSeconds: number;
	onClose: () => void;
	formatDuration: (seconds: number) => string;
}) {
	useEffect(() => {
		log.debug("Info Panel State", {
			roomId,
			sessionSeconds,
			formattedDuration: formatDuration(sessionSeconds),
		});
	}, [roomId, sessionSeconds, formatDuration]);

	return (
		<div className="h-full rounded-[32px] p-6 border border-border bg-card/80 backdrop-blur-3xl shadow-2xl ring-1 ring-border/60 text-foreground">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-xl font-bold">Meeting Info</h2>
				<button
					onClick={onClose}
					className="p-2 hover:bg-muted rounded-full transition-colors"
				>
					<X size={20} />
				</button>
			</div>
			<div className="space-y-4">
				<div className="p-4 rounded-2xl bg-muted/40 border border-border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
					<p className="text-sm text-muted-foreground mb-1">Room ID</p>
					<p className="font-mono text-lg select-all text-foreground/90">
						{roomId}
					</p>
				</div>
				<div className="p-4 rounded-2xl bg-muted/40 border border-border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
					<p className="text-sm text-muted-foreground mb-1">Duration</p>
					<p className="font-mono text-lg text-foreground/90">
						{formatDuration(sessionSeconds)}
					</p>
				</div>
			</div>
		</div>
	);
}
