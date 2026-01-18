import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { AudioRenderer } from "../atomic";
import {
	ChatPanel,
	ConnectionLostOverlay,
	ControlBar,
	InviteModal,
	MobileControlSheet,
	MobilePanel,
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
	onAddPeople?: () => void;
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
	onAddPeople,
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
	const [showInviteModal, setShowInviteModal] = useState(false);
	const [showTour, setShowTour] = useState(false);
	const [isIdle, setIsIdle] = useState(false);
	const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
	const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isMobile = useIsMobile();

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

	const handleCopyLink = useCallback(() => {
		const meetingLink = window.location.href;
		navigator.clipboard.writeText(meetingLink);
	}, []);

	const handleAddPeople = useCallback(() => {
		setShowInviteModal(true);
		onAddPeople?.();
	}, [onAddPeople]);

	return (
		<div
			className={cn(
				"chalk-root relative min-h-screen w-full overflow-hidden flex flex-col justify-between",
				isMobile ? "p-2" : "p-6",
				className,
			)}
			data-chalk-theme={theme === "system" ? undefined : theme}
		>
			<div className={cn("absolute z-10", isMobile ? "top-3 left-3" : "top-6 left-8")}>
				<h1 className="text-sm font-semibold text-(--chalk-text-secondary)/80">
					{roomName || "Video Call Screen"}
				</h1>
			</div>

			{/* Layout Switcher - hidden on mobile */}
			<div className={cn("absolute top-6 right-8 z-10 gap-2", isMobile ? "hidden" : "flex")}>
				<button
					onClick={() => setLayout("grid")}
					className={cn(
						"px-3 py-1.5 rounded-full text-xs font-semibold transition-all shadow-lg border",
						layout === "grid"
							? "border-transparent"
							: "border-(--chalk-pill-border) hover:border-transparent"
					)}
					style={{
						background:
							layout === "grid"
								? "var(--chalk-pill-bg-active)"
								: "var(--chalk-pill-bg)",
						color:
							layout === "grid"
								? "var(--chalk-pill-text-active)"
								: "var(--chalk-pill-text)",
					}}
					aria-label="Grid layout"
				>
					Grid
				</button>
				<button
					onClick={() => setLayout("spotlight")}
					className={cn(
						"px-3 py-1.5 rounded-full text-xs font-semibold transition-all shadow-lg border",
						layout === "spotlight"
							? "border-transparent"
							: "border-(--chalk-pill-border) hover:border-transparent"
					)}
					style={{
						background:
							layout === "spotlight"
								? "var(--chalk-pill-bg-active)"
								: "var(--chalk-pill-bg)",
						color:
							layout === "spotlight"
								? "var(--chalk-pill-text-active)"
								: "var(--chalk-pill-text)",
					}}
					aria-label="Spotlight layout"
				>
					Spotlight
				</button>
				<button
					onClick={() => setLayout("sidebar")}
					className={cn(
						"px-3 py-1.5 rounded-full text-xs font-semibold transition-all shadow-lg border",
						layout === "sidebar"
							? "border-transparent"
							: "border-(--chalk-pill-border) hover:border-transparent"
					)}
					style={{
						background:
							layout === "sidebar"
								? "var(--chalk-pill-bg-active)"
								: "var(--chalk-pill-bg)",
						color:
							layout === "sidebar"
								? "var(--chalk-pill-text-active)"
								: "var(--chalk-pill-text)",
					}}
					aria-label="Sidebar layout"
				>
					Sidebar
				</button>
			</div>

			{/* Main content area */}
			<div className={cn("flex-1 min-h-0 relative flex flex-row gap-4", isMobile ? "pt-6 pb-20" : "pt-8")}>
				<div
					className="flex-1 min-h-0 h-full relative"
					data-tour="video-grid"
				>
					{showScreenShare && screenSharer?.screenShareTrack ? (
						<ScreenShareView
							screenShareTrack={screenSharer.screenShareTrack}
							sharedByName={screenSharer.displayName || "Unknown"}
							participants={allParticipants}
						/>
					) : (
						<VideoGrid
							participants={allParticipants}
							layout={layout}
							variant={isMobile ? "mobile" : "desktop"}
						/>
					)}

					<div className="absolute top-4 right-4 z-50">
						<NotificationStack notifications={[]} onDismiss={() => {}} />
					</div>
				</div>

				{/* Desktop sidebar panels */}
				{!isMobile && activePanel && (
					<div className="w-[340px] shrink-0 rounded-xl overflow-hidden flex flex-col shadow-2xl transition-all duration-300 ease-in-out self-stretch">
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
								variant="sidebar"
								onAddPeople={handleAddPeople}
							/>
						)}
						{activePanel === "transcription" && (
							<TranscriptionPanel
								transcripts={transcripts}
								onClose={() => setActivePanel(null)}
								variant="sidebar"
							/>
						)}
					</div>
				)}
			</div>

			{/* Mobile full-screen panels */}
			{isMobile && activePanel === "chat" && (
				<MobilePanel title="Chat" onClose={() => setActivePanel(null)}>
					<ChatPanel
						messages={chatMessages}
						onSendMessage={onSendMessage || (() => {})}
						variant="mobile"
					/>
				</MobilePanel>
			)}
			{isMobile && activePanel === "participants" && (
				<MobilePanel title="People" onClose={() => setActivePanel(null)}>
					<ParticipantList
						participants={allParticipants}
						variant="mobile"
						onAddPeople={handleAddPeople}
					/>
				</MobilePanel>
			)}
			{isMobile && activePanel === "transcription" && (
				<MobilePanel title="Transcript" onClose={() => setActivePanel(null)}>
					<TranscriptionPanel
						transcripts={transcripts}
						variant="mobile"
					/>
				</MobilePanel>
			)}

			{/* Mobile Control Sheet */}
			{isMobile && (
				<MobileControlSheet
					isOpen={isMobileSheetOpen}
					onClose={() => setIsMobileSheetOpen(false)}
					isMuted={isMuted}
					isVideoEnabled={isVideoEnabled}
					isScreenSharing={isScreenSharing}
					isRecording={isRecording}
					isChatOpen={activePanel === "chat"}
					isParticipantsOpen={activePanel === "participants"}
					isTranscriptionEnabled={activePanel === "transcription"}
					isHandRaised={isHandRaised}
					isWhiteboardOpen={isWhiteboardOpen}
					onToggleMute={onToggleMute}
					onToggleVideo={onToggleVideo}
					onToggleScreenShare={enableScreenShare ? onToggleScreenShare : undefined}
					onToggleRecording={enableRecording && canRecord ? onToggleRecording : undefined}
					onToggleChat={enableChat ? () => { togglePanel("chat"); setIsMobileSheetOpen(false); } : undefined}
					onToggleParticipants={() => { togglePanel("participants"); setIsMobileSheetOpen(false); }}
					onToggleTranscription={enableTranscription ? () => { togglePanel("transcription"); onToggleTranscription?.(); setIsMobileSheetOpen(false); } : undefined}
					onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
					onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
					onOpenReactions={enableReactions ? () => { setIsReactionPickerOpen(true); setIsMobileSheetOpen(false); } : undefined}
					onLeave={onLeave}
					enableScreenShare={enableScreenShare}
					enableRecording={enableRecording}
					enableHandRaise={enableHandRaise}
					enableReactions={enableReactions}
					enableWhiteboard={enableWhiteboard}
					enableTranscription={enableTranscription}
					enableChat={enableChat}
				/>
			)}

			{/* Auto-hide control bar */}
			<div
				className={cn(
					"w-full z-20 transition-all duration-300",
					isIdle && !activePanel ? "opacity-0 translate-y-2" : "opacity-100",
					isMobile && "absolute bottom-4 left-0 right-0 flex justify-center",
				)}
				style={isMobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
			>
				<div className="relative">
					<ControlBar
						variant={isMobile ? "mobile" : "floating"}
						isMuted={isMuted}
						isVideoEnabled={isVideoEnabled}
						isScreenSharing={isScreenSharing}
						isHandRaised={isHandRaised}
						isWhiteboardOpen={isWhiteboardOpen}
						isRecording={isRecording}
						meetingDuration={meetingDuration}
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
						onOpenMore={isMobile ? () => setIsMobileSheetOpen(true) : undefined}
						className={isMobile ? "" : "w-full"}
					/>
					{enableReactions && !isMobile && (
						<ReactionPicker
							isOpen={isReactionPickerOpen}
							onClose={() => setIsReactionPickerOpen(false)}
							onSelect={(emoji) => {
								onSendReaction?.(emoji);
								setIsReactionPickerOpen(false);
							}}
							position="top"
							className="bottom-full mb-3 left-1/2 -translate-x-1/2"
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

			<InviteModal
				isOpen={showInviteModal}
				onClose={() => setShowInviteModal(false)}
				meetingLink={typeof window !== 'undefined' ? window.location.href : ''}
				meetingId={roomName}
				onCopyLink={handleCopyLink}
			/>

			{/* Hidden audio renderer for remote participant audio */}
			<AudioRenderer participants={allParticipants} />
		</div>
	);
};

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
