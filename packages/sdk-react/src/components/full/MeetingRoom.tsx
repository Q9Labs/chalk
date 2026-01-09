import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { AudioRenderer } from "../atomic";
import {
	ChatPanel,
	ConnectionLostOverlay,
	ControlBar,
	MeetingHeader,
	NotificationStack,
	ParticipantList,
	ReactionPicker,
	ScreenShareView,
	TranscriptionPanel,
	VideoGrid,
} from "../composite";
import { GuidedTour } from "./GuidedTour";
import { WhiteboardPanel } from "./WhiteboardPanel";

const IDLE_TIMEOUT = 3000; // 3 seconds

export interface Participant {
	id: string;
	displayName: string;
	isLocal?: boolean;
	isSpeaking?: boolean;
	isMuted?: boolean;
	isVideoEnabled?: boolean;
	isScreenSharing?: boolean;
	isHandRaised?: boolean;
	connectionQuality?: 1 | 2 | 3 | 4;
	avatarUrl?: string;
	videoTrack?: MediaStreamTrack | null;
	audioTrack?: MediaStreamTrack | null;
	screenShareTrack?: MediaStreamTrack | null;
	screenShareAudioTrack?: MediaStreamTrack | null;
	role?: "host" | "co-host" | "participant";
}

export interface ChatMessage {
	id: string;
	senderId: string;
	senderName: string;
	content: string;
	timestamp: Date;
	isLocal?: boolean;
}

export interface TranscriptEntry {
	id: string;
	speaker: string;
	speakerId: string;
	text: string;
	timestamp: Date;
	isInterim?: boolean;
	confidence?: number;
}

export interface MeetingRoomProps {
	roomName: string;
	localParticipant: Participant;
	participants: Participant[];
	isMuted?: boolean;
	isVideoEnabled?: boolean;
	isScreenSharing?: boolean;
	isHandRaised?: boolean;
	isWhiteboardOpen?: boolean;
	isRecording?: boolean;
	recordingDuration?: number;
	meetingDuration?: number;
	canRecord?: boolean;
	isTranscribing?: boolean;
	transcripts?: TranscriptEntry[];
	chatMessages?: ChatMessage[];
	onSendMessage?: (content: string) => void;
	enableChat?: boolean;
	enableRecording?: boolean;
	enableScreenShare?: boolean;
	enableHandRaise?: boolean;
	enableReactions?: boolean;
	enableWhiteboard?: boolean;
	enableTranscription?: boolean;
	enableTour?: boolean;
	defaultLayout?: "grid" | "spotlight" | "sidebar";
	defaultChatOpen?: boolean;
	defaultParticipantsOpen?: boolean;
	defaultTranscriptionOpen?: boolean;
	showTourOnFirstVisit?: boolean;
	onToggleMute?: () => void;
	onToggleVideo?: () => void;
	onToggleScreenShare?: () => void;
	onToggleRecording?: () => void;
	onToggleHandRaise?: () => void;
	onToggleWhiteboard?: () => void;
	onSendReaction?: (emoji: string) => void;
	onToggleTranscription?: () => void;
	onLeave?: () => void;
	onTourComplete?: () => void;
	connectionStatus?: "connected" | "connecting" | "reconnecting" | "failed";
	onRetryConnection?: () => void;
	theme?: "light" | "dark" | "system";
	className?: string;
}

const MeetingRoomBase: React.FC<MeetingRoomProps> = ({
	roomName,
	localParticipant,
	participants,
	isMuted = false,
	isVideoEnabled = false,
	isScreenSharing = false,
	isHandRaised = false,
	isWhiteboardOpen = false,
	isRecording = false,
	recordingDuration: _recordingDuration = 0,
	meetingDuration = 0,
	canRecord = false,
	isTranscribing = false,
	transcripts = [],
	chatMessages = [],
	onSendMessage,
	enableChat = true,
	enableRecording = true,
	enableScreenShare = true,
	enableHandRaise = true,
	enableReactions = true,
	enableWhiteboard = true,
	enableTranscription = true,
	enableTour = true,
	defaultLayout = "grid",
	defaultChatOpen = false,
	defaultParticipantsOpen = false,
	defaultTranscriptionOpen = false,
	showTourOnFirstVisit = true,
	onToggleMute,
	onToggleVideo,
	onToggleScreenShare,
	onToggleRecording,
	onToggleHandRaise,
	onToggleWhiteboard,
	onSendReaction,
	onToggleTranscription,
	onLeave,
	onTourComplete,
	connectionStatus = "connected",
	onRetryConnection,
	theme = "system",
	className,
}) => {
	const [activePanel, setActivePanel] = useState<
		"chat" | "participants" | "transcription" | null
	>(() => {
		if (defaultChatOpen) return "chat";
		if (defaultParticipantsOpen) return "participants";
		if (defaultTranscriptionOpen) return "transcription";
		return null;
	});

	const [layout, setLayout] = useState<"grid" | "spotlight" | "sidebar">(
		defaultLayout || "grid",
	);
	const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
	const [showTour, setShowTour] = useState(false);
	const [isIdle, setIsIdle] = useState(false);
	const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const resetIdleTimer = useCallback(() => {
		setIsIdle(false);
		if (idleTimerRef.current) {
			clearTimeout(idleTimerRef.current);
		}
		idleTimerRef.current = setTimeout(() => {
			setIsIdle(true);
		}, IDLE_TIMEOUT);
	}, []);

	useEffect(() => {
		const events = ["mousemove", "mousedown", "keydown", "touchstart"];
		events.forEach((event) => window.addEventListener(event, resetIdleTimer));
		resetIdleTimer();
		return () => {
			events.forEach((event) =>
				window.removeEventListener(event, resetIdleTimer),
			);
			if (idleTimerRef.current) {
				clearTimeout(idleTimerRef.current);
			}
		};
	}, [resetIdleTimer]);

	useEffect(() => {
		if (enableTour && showTourOnFirstVisit) {
			const hasSeenTour = localStorage.getItem("chalk-tour-completed");
			if (!hasSeenTour) {
				setShowTour(true);
			}
		}
	}, [enableTour, showTourOnFirstVisit]);

	const togglePanel = (panel: "chat" | "participants" | "transcription") => {
		setActivePanel((current) => (current === panel ? null : panel));
	};

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName))
				return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			switch (e.key.toLowerCase()) {
				case "m":
					onToggleMute?.();
					break;
				case "v":
					onToggleVideo?.();
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onToggleMute, onToggleVideo]);

	const screenSharer = participants.find((p) => p.isScreenSharing);
	const showScreenShare = !!screenSharer;

	const allParticipants = useMemo(() => {
		// Filter out localParticipant from participants to avoid duplicates
		// (useParticipants already includes local in participants array)
		const others = participants.filter((p) => p.id !== localParticipant?.id);
		return localParticipant ? [localParticipant, ...others] : participants;
	}, [localParticipant, participants]);

	const handleTourComplete = () => {
		setShowTour(false);
		localStorage.setItem("chalk-tour-completed", "true");
		onTourComplete?.();
	};

	return (
		<div
			className={cn(
				"chalk-root relative h-screen w-full text-[var(--chalk-text-primary)] overflow-hidden",
				"bg-gradient-to-b from-[#1a1f2e] to-[#0f1219]",
				className,
			)}
			data-chalk-theme={theme === "system" ? undefined : theme}
		>
			{/* Auto-hide header */}
			<div
				className={cn(
					"absolute top-0 left-0 right-0 z-20 transition-all duration-300",
					isIdle && !activePanel ? "opacity-0 -translate-y-2" : "opacity-100",
				)}
			>
				<MeetingHeader
					roomName={roomName}
					isRecording={isRecording}
					duration={meetingDuration}
					isTranscribing={isTranscribing}
					layout={layout}
					onLayoutChange={setLayout}
					className="px-4"
				/>
			</div>

			{/* Main content area */}
			<div className="absolute inset-0 flex overflow-hidden pt-14 pb-24 px-4">
				<div
					className="flex-1 min-w-0 relative flex items-center justify-center p-2"
					data-tour="video-grid"
				>
					{showScreenShare && screenSharer?.screenShareTrack ? (
						<ScreenShareView
							screenShareTrack={screenSharer.screenShareTrack}
							sharedByName={screenSharer.displayName || "Unknown"}
							participants={allParticipants}
						/>
					) : (
						<VideoGrid participants={allParticipants} layout={layout} />
					)}

					<div className="absolute top-4 right-4 z-50">
						<NotificationStack notifications={[]} onDismiss={() => {}} />
					</div>
				</div>

				{activePanel && (
					<div className="ml-2 w-[340px] shrink-0 bg-black/40 backdrop-blur-md rounded-xl overflow-hidden flex flex-col shadow-[var(--chalk-shadow-panel)] transition-all duration-300 ease-in-out">
						{activePanel === "chat" && (
							<ChatPanel
								messages={chatMessages}
								onSendMessage={onSendMessage || (() => {})}
								onClose={() => setActivePanel(null)}
							/>
						)}
						{activePanel === "participants" && (
							<ParticipantList
								participants={allParticipants}
								onClose={() => setActivePanel(null)}
							/>
						)}
						{activePanel === "transcription" && (
							<TranscriptionPanel
								transcripts={transcripts}
								onClose={() => setActivePanel(null)}
							/>
						)}
					</div>
				)}
			</div>

			{/* Auto-hide control bar */}
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center transition-all duration-300",
					isIdle && !activePanel ? "opacity-0 translate-y-2" : "opacity-100",
				)}
			>
				<div className="relative pointer-events-auto">
					<ControlBar
						variant="floating"
						isMuted={isMuted}
						isVideoEnabled={isVideoEnabled}
						isScreenSharing={isScreenSharing}
						isHandRaised={isHandRaised}
						isWhiteboardOpen={isWhiteboardOpen}
						isRecording={isRecording}
						isChatOpen={activePanel === "chat"}
						isParticipantsOpen={activePanel === "participants"}
						isTranscriptionEnabled={activePanel === "transcription"}
						onToggleMute={onToggleMute}
						onToggleVideo={onToggleVideo}
						onToggleScreenShare={
							enableScreenShare ? onToggleScreenShare : undefined
						}
						onToggleRecording={
							enableRecording && canRecord ? onToggleRecording : undefined
						}
						onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
						onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
						onLeave={onLeave}
						onToggleChat={enableChat ? () => togglePanel("chat") : undefined}
						onToggleParticipants={() => togglePanel("participants")}
						onToggleTranscription={
							enableTranscription
								? () => {
										togglePanel("transcription");
										onToggleTranscription?.();
									}
								: undefined
						}
						onOpenReactions={
							enableReactions ? () => setIsReactionPickerOpen(true) : undefined
						}
						className="bg-black/60 backdrop-blur-md px-4 py-2.5 shadow-[var(--chalk-shadow-controls)]"
					/>
					{enableReactions && (
						<ReactionPicker
							isOpen={isReactionPickerOpen}
							onClose={() => setIsReactionPickerOpen(false)}
							onSelect={(emoji) => {
								onSendReaction?.(emoji);
								setIsReactionPickerOpen(false);
							}}
							position="top"
							className="bottom-full mb-3"
						/>
					)}
				</div>
			</div>

			<ConnectionLostOverlay
				isVisible={
					connectionStatus === "reconnecting" || connectionStatus === "failed"
				}
				status={connectionStatus === "reconnecting" ? "reconnecting" : "failed"}
				onRetry={onRetryConnection}
			/>

			{/* Whiteboard overlay */}
			{enableWhiteboard && isWhiteboardOpen && (
				<WhiteboardPanel onClose={onToggleWhiteboard} />
			)}

			{enableTour && (
				<GuidedTour
					isOpen={showTour}
					onComplete={handleTourComplete}
					onSkip={handleTourComplete}
					showSkip={true}
				/>
			)}

			{/* Hidden audio renderer for remote participant audio */}
			<AudioRenderer participants={allParticipants} />
		</div>
	);
};

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
