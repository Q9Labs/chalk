import type React from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { ColumnIcon, LayoutGridIcon, Maximize01Icon, Moon02Icon, Sun02Icon } from "../../utils/icons";
import { AudioRenderer, ReactionBubble } from "../atomic";
import { Toggle, Tooltip, TooltipTrigger, TooltipContent } from "../ui";
import {
	ChatPanel,
	ConnectionLostOverlay,
	ControlBar,
	InviteModal,
	InviteToast,
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

export interface ActiveReaction {
	id: string;
	participantId: string;
	participantName: string;
	emoji: string;
	timestamp: Date;
}

export interface MeetingRoomProps {
	roomName: string;
	localParticipant: Participant;
	participants: Participant[];
	activeReactions?: readonly ActiveReaction[];
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
	unreadChatCount?: number;
	onSendMessage?: (content: string) => void;
	onChatOpen?: () => void;
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
	/** Show the invite toast on join. Default: true */
	showInviteToastOnJoin?: boolean;
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
	activeReactions = [],
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
	unreadChatCount = 0,
	onSendMessage,
	onChatOpen,
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
	showInviteToastOnJoin = true,
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
	const [showInviteToast, setShowInviteToast] = useState(showInviteToastOnJoin);
	const [showTour, setShowTour] = useState(false);
	const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
	const [isExiting, setIsExiting] = useState(false);
	const isMobile = useIsMobile();
	const [isDarkMode, setIsDarkMode] = useState(() => {
		if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
			return true;
		}
		return theme === "dark" || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	});

	const handleLeave = useCallback(() => {
		setIsExiting(true);
		// Wait for animation to complete before calling onLeave
		setTimeout(() => {
			onLeave?.();
		}, 600);
	}, [onLeave]);

	const toggleTheme = useCallback(() => {
		setIsDarkMode((prev) => {
			const newValue = !prev;
			if (typeof document !== "undefined") {
				document.documentElement.classList.remove("light", "dark");
				document.documentElement.classList.add(newValue ? "dark" : "light");
			}
			return newValue;
		});
	}, []);

	useEffect(() => {
		if (enableTour && showTourOnFirstVisit) {
			const hasSeenTour = localStorage.getItem("chalk-tour-completed");
			if (!hasSeenTour) {
				setShowTour(true);
			}
		}
	}, [enableTour, showTourOnFirstVisit]);

	// Mark chat as read if opened by default
	useEffect(() => {
		if (defaultChatOpen) {
			onChatOpen?.();
		}
	}, []);

	const togglePanel = (panel: "chat" | "participants" | "transcription") => {
		setActivePanel((current) => {
			const newPanel = current === panel ? null : panel;
			if (newPanel === "chat") {
				onChatOpen?.();
			}
			return newPanel;
		});
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
			data-chalk
			className={cn(
				"chalk-root chalk-theme-transition relative h-screen w-full overflow-hidden flex flex-col bg-background text-foreground",
				isMobile ? "p-2" : "p-0",
				className,
			)}
			data-chalk-theme={theme === "system" ? undefined : theme}
		>
			{/* Layout Switcher - hidden on mobile and when panels are open, appears on hover */}
			{!isMobile && !activePanel && (
				<div
					className="absolute top-0 right-0 z-20 p-4 group"
					onMouseEnter={(e) => e.currentTarget.dataset.hovered = "true"}
					onMouseLeave={(e) => e.currentTarget.dataset.hovered = "false"}
				>
										<div className="flex bg-black/40 backdrop-blur-md rounded-lg p-0.5 border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 gap-0.5">
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															onClick={toggleTheme}
															className="flex items-center justify-center rounded-md w-7 h-7 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
															aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
														>
															{isDarkMode ? <Sun02Icon className="w-3.5 h-3.5" /> : <Moon02Icon className="w-3.5 h-3.5" />}
														</button>
													}
												/>
												<TooltipContent side="bottom">{isDarkMode ? "Light Mode" : "Dark Mode"}</TooltipContent>
											</Tooltip>
											<div className="w-px bg-white/10 my-1" />
											<Tooltip>
												<TooltipTrigger
													render={
														<Toggle
															pressed={layout === "grid"}
															onPressedChange={() => setLayout("grid")}
															aria-label="Grid layout"
															className="data-[pressed]:bg-teal-600 data-[pressed]:text-white text-zinc-400 hover:text-white rounded-md w-7 h-7 p-0"
														/>
													}
												>
													<LayoutGridIcon className="w-3.5 h-3.5" />
												</TooltipTrigger>
												<TooltipContent side="bottom">Grid</TooltipContent>
											</Tooltip>
											<Tooltip>
												<TooltipTrigger
													render={
														<Toggle
															pressed={layout === "spotlight"}
															onPressedChange={() => setLayout("spotlight")}
															aria-label="Spotlight layout"
															className="data-[pressed]:bg-teal-600 data-[pressed]:text-white text-zinc-400 hover:text-white rounded-md w-7 h-7 p-0"
														/>
													}
												>
													<Maximize01Icon className="w-3.5 h-3.5" />
												</TooltipTrigger>
												<TooltipContent side="bottom">Spotlight</TooltipContent>
											</Tooltip>
											<Tooltip>
												<TooltipTrigger
													render={
														<Toggle
															pressed={layout === "sidebar"}
															onPressedChange={() => setLayout("sidebar")}
															aria-label="Sidebar layout"
															className="data-[pressed]:bg-teal-600 data-[pressed]:text-white text-zinc-400 hover:text-white rounded-md w-7 h-7 p-0"
														/>
													}
												>
													<ColumnIcon className="w-3.5 h-3.5" />
												</TooltipTrigger>
												<TooltipContent side="bottom">Sidebar</TooltipContent>
											</Tooltip>
										</div>				</div>
			)}

			{/* Main content area - Split View */}
			<div
				className={cn(
					"flex-1 min-h-0 relative flex flex-row overflow-hidden",
					isMobile ? "gap-2 pt-2" : "gap-4 px-4 pt-4",
					isExiting && "pointer-events-none"
				)}
			>
				{/* Stage / Video Grid */}
				<div className={cn(
					"flex-1 h-full min-w-0 relative flex flex-col rounded-3xl overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.2,0,0,1)]",
					isExiting && "chalk-animate-void-exit"
				)}>
					{showScreenShare && screenSharer?.screenShareTrack ? (
						<ScreenShareView
							screenShareTrack={screenSharer.screenShareTrack}
							sharedByName={screenSharer.displayName || "Unknown"}
							participants={allParticipants}
							thumbnailPosition={layout === "sidebar" ? "right" : "bottom"}
						/>
					) : (
						<VideoGrid
							participants={allParticipants}
							layout={layout}
							variant={isMobile ? "mobile" : "desktop"}
							className="p-4" // Add internal padding to the grid
						/>
					)}

					<div className="absolute top-14 right-4 z-50">
						<NotificationStack notifications={[]} onDismiss={() => {}} />
					</div>

					{/* Floating reactions */}
					{activeReactions.length > 0 && (
						<div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 flex gap-2 pointer-events-none">
							{activeReactions.map((reaction) => (
								<ReactionBubble
									key={reaction.id}
									emoji={reaction.emoji}
									participantName={reaction.participantName}
								/>
							))}
						</div>
					)}
				</div>

				{/* Desktop Sidebar - Integrated, pushing content */}
				{!isMobile && activePanel && (
					<div
						className={cn(
							"w-[360px] shrink-0 h-full rounded-3xl overflow-hidden flex flex-col bg-card/80 backdrop-blur-xl border border-border/50 shadow-xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
							"animate-in slide-in-from-right-10 fade-in duration-300"
						)}
					>
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
					<TranscriptionPanel transcripts={transcripts} variant="mobile" />
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
					onToggleScreenShare={
						enableScreenShare ? onToggleScreenShare : undefined
					}
					onToggleRecording={
						enableRecording && canRecord ? onToggleRecording : undefined
					}
					onToggleChat={
						enableChat
							? () => {
									togglePanel("chat");
									setIsMobileSheetOpen(false);
								}
							: undefined
					}
					onToggleParticipants={() => {
						togglePanel("participants");
						setIsMobileSheetOpen(false);
					}}
					onToggleTranscription={
						enableTranscription
							? () => {
									togglePanel("transcription");
									onToggleTranscription?.();
									setIsMobileSheetOpen(false);
								}
							: undefined
					}
					onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
					onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
					onOpenReactions={
						enableReactions
							? () => {
									setIsReactionPickerOpen(true);
									setIsMobileSheetOpen(false);
								}
							: undefined
					}
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

			{/* Bottom Dock Control Bar */}
			<div className="shrink-0 z-20 w-full flex justify-center mt-[-1px]">
				<div className="relative w-full">
					<ControlBar
						variant={isMobile ? "mobile" : "dock"}
						isMuted={isMuted}
						isVideoEnabled={isVideoEnabled}
						isScreenSharing={isScreenSharing}
						isHandRaised={isHandRaised}
						isWhiteboardOpen={isWhiteboardOpen}
						isRecording={isRecording}
						meetingDuration={meetingDuration}
						unreadChatCount={unreadChatCount}
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
						onToggleWhiteboard={
							enableWhiteboard ? onToggleWhiteboard : undefined
						}
						onLeave={handleLeave}
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
						className={cn(
							isMobile ? "absolute bottom-4 left-1/2 -translate-x-1/2" : "",
							isExiting ? "chalk-animate-dock-down" : "chalk-animate-dock-up"
						)}
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
							className="absolute bottom-24 left-1/2 -translate-x-1/2"
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
			{enableWhiteboard && (
				<WhiteboardPanel
					isVisible={isWhiteboardOpen}
					onClose={onToggleWhiteboard}
					theme={theme === "system" ? "auto" : theme}
				/>
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
				meetingLink={typeof window !== "undefined" ? window.location.href : ""}
				meetingId={roomName}
				onCopyLink={handleCopyLink}
			/>

			<InviteToast
				isVisible={showInviteToast && !showTour}
				onDismiss={() => setShowInviteToast(false)}
				meetingLink={typeof window !== "undefined" ? window.location.href : ""}
			/>

			{/* Hidden audio renderer for remote participant audio */}
			<AudioRenderer participants={allParticipants} />
		</div>
	);
};

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
