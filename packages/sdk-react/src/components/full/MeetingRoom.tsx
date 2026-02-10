import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useDraggable } from "../../hooks/ui/useDraggable";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import {
	ArrowDown01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowUp01Icon,
	ColumnIcon,
	LayoutGridIcon,
	Maximize01Icon,
	Moon02Icon,
	Sun02Icon,
} from "../../utils/icons";
import { AudioRenderer, ReactionBubble, VideoTile } from "../atomic";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui";
import { GuidedTour } from "./GuidedTour";
import { SplitStage } from "./SplitStage";
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
	canManageParticipants?: boolean;
	onToggleParticipantMute?: (participantId: string) => void;
	onRemoveParticipant?: (participantId: string) => void;
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
	/** Per-participant volume overrides (0-100). Only contains adjusted participants. */
	participantVolumes?: ReadonlyMap<string, number>;
	/** Called when a participant's volume is changed via the slider. */
	onParticipantVolumeChange?: (id: string, volume: number) => void;
	/** Get normalized volume (0-1) for a participant. Used by AudioRenderer. */
	getParticipantVolume?: (participantId: string) => number;
	theme?: "light" | "dark" | "system";
	/** Exposes Excalidraw imperative API when whiteboard mounts. */
	onWhiteboardExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
	className?: string;
}

const MeetingRoomBase: React.FC<MeetingRoomProps> = ({
	roomName,
	localParticipant,
	participants,
	canManageParticipants = false,
	onToggleParticipantMute,
	onRemoveParticipant,
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
	participantVolumes,
	onParticipantVolumeChange,
	getParticipantVolume,
	theme = "system",
	onWhiteboardExcalidrawApiReady,
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
	const [isFilmstripOpen, setIsFilmstripOpen] = useState(true);
	const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
	const [showInviteModal, setShowInviteModal] = useState(false);
	const [showInviteToast, setShowInviteToast] = useState(showInviteToastOnJoin);
	const [showTour, setShowTour] = useState(false);
	const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
	const [isExiting, setIsExiting] = useState(false);
	const leaveTimeoutRef = useRef<number | null>(null);
	const isMobile = useIsMobile();
	const [isDarkMode, setIsDarkMode] = useState(() => {
		if (
			typeof document !== "undefined" &&
			document.documentElement.classList.contains("dark")
		) {
			return true;
		}
		return (
			theme === "dark" ||
			(theme === "system" &&
				typeof window !== "undefined" &&
				window.matchMedia("(prefers-color-scheme: dark)").matches)
		);
	});

	const containerRef = useRef<HTMLDivElement>(null);
	const pillRef = useRef<HTMLDivElement>(null);
	const { dragHandlers: pillDragHandlers } = useDraggable(pillRef, {
		boundaryRef: containerRef,
		snapToCorners: true,
		cornerMargin: 24,
		bounce: 0.2, // Less bounce for snapping
		friction: 0.94,
	});

	const handleLeave = useCallback(() => {
		setIsExiting(true);
		if (leaveTimeoutRef.current !== null) {
			window.clearTimeout(leaveTimeoutRef.current);
		}
		// Wait for animation to complete before calling onLeave
		leaveTimeoutRef.current = window.setTimeout(() => {
			onLeave?.();
			setIsExiting(false);
			leaveTimeoutRef.current = null;
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

	useEffect(() => {
		return () => {
			if (leaveTimeoutRef.current !== null) {
				window.clearTimeout(leaveTimeoutRef.current);
			}
		};
	}, []);

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
			const target = e.target as HTMLElement;
			// Prevent shortcuts when typing in inputs, textareas, or contentEditable elements
			if (
				["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
				target.isContentEditable
			)
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
	const isSplit =
		!isMobile && enableWhiteboard && isWhiteboardOpen && showScreenShare;
	const isStageMode =
		isSplit ||
		(enableWhiteboard && isWhiteboardOpen) ||
		(showScreenShare && !!screenSharer?.screenShareTrack);

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
			ref={containerRef}
			data-chalk
			className={cn(
				"chalk-root chalk-theme-transition relative h-screen w-full overflow-hidden flex flex-col bg-background text-foreground",
				isMobile ? "p-2" : "p-0",
				className,
			)}
			data-chalk-theme={theme === "system" ? undefined : theme}
		>
			{/* Room Name Pill */}
			{!isMobile && (
				<div
					ref={pillRef}
					{...pillDragHandlers}
					className="absolute top-4 left-6 z-30"
				>
					<div className="px-3 py-1 rounded-full bg-black/40 backdrop-blur-md border border-white/10 select-none">
						<span className="text-xs font-medium text-zinc-200 tracking-tight">
							{roomName}
						</span>
					</div>
				</div>
			)}
			{/* Layout Switcher - Option 2 Redesign: Active State Expander */}
			{!isMobile && !activePanel && (
				<div
					className="absolute top-4 right-4 z-20 group"
					role="region"
					aria-label="Layout controls"
					onMouseEnter={(e) => (e.currentTarget.dataset.hovered = "true")}
					onMouseLeave={(e) => (e.currentTarget.dataset.hovered = "false")}
				>
					<div className="flex flex-row-reverse items-center bg-black/40 backdrop-blur-md rounded-lg p-1 border border-white/10 gap-1 transition-all duration-300">
						{/* Active Layout Icon - Always visible */}
						<div className="flex items-center justify-center rounded-md w-7 h-7 text-white bg-teal-600 cursor-default shadow-sm">
							{layout === "grid" && <LayoutGridIcon className="w-3.5 h-3.5" />}
							{layout === "spotlight" && (
								<Maximize01Icon className="w-3.5 h-3.5" />
							)}
							{layout === "sidebar" && <ColumnIcon className="w-3.5 h-3.5" />}
						</div>

						{/* Expandable Menu - Revealed on hover */}
						<div className="flex items-center gap-1 max-w-0 overflow-hidden opacity-0 group-hover:max-w-[200px] group-hover:opacity-100 group-focus-within:max-w-[200px] group-focus-within:opacity-100 transition-all duration-300 ease-in-out">
							{/* Theme Toggle */}
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											type="button"
											onClick={toggleTheme}
											className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
											aria-label={
												isDarkMode
													? "Switch to light mode"
													: "Switch to dark mode"
											}
										>
											{isDarkMode ? (
												<Sun02Icon className="w-3.5 h-3.5" />
											) : (
												<Moon02Icon className="w-3.5 h-3.5" />
											)}
										</button>
									}
								/>
								<TooltipContent side="bottom">
									{isDarkMode ? "Light Mode" : "Dark Mode"}
								</TooltipContent>
							</Tooltip>

							<div className="w-px h-4 bg-white/10 mx-1" />

							{/* Other Layout Options */}
							{layout !== "grid" && (
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => setLayout("grid")}
												className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
												aria-label="Grid layout"
											>
												<LayoutGridIcon className="w-3.5 h-3.5" />
											</button>
										}
									/>
									<TooltipContent side="bottom">Grid</TooltipContent>
								</Tooltip>
							)}
							{layout !== "spotlight" && (
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => setLayout("spotlight")}
												className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
												aria-label="Spotlight layout"
											>
												<Maximize01Icon className="w-3.5 h-3.5" />
											</button>
										}
									/>
									<TooltipContent side="bottom">Spotlight</TooltipContent>
								</Tooltip>
							)}
							{layout !== "sidebar" && (
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => setLayout("sidebar")}
												className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
												aria-label="Sidebar layout"
											>
												<ColumnIcon className="w-3.5 h-3.5" />
											</button>
										}
									/>
									<TooltipContent side="bottom">Sidebar</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Main content area - Split View */}
			<div
				className={cn(
					"flex-1 min-h-0 relative flex flex-row overflow-hidden",
					isMobile ? "gap-2 pt-2" : "gap-4 px-4 pt-4",
					isExiting && "pointer-events-none",
				)}
			>
				{/* Stage / Video Grid */}
				<div
					className={cn(
						"flex-1 h-full min-w-0 relative flex rounded-3xl overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.2,0,0,1)]",
						isStageMode && layout === "sidebar" ? "flex-row" : "flex-col",
						isExiting && "chalk-animate-void-exit",
					)}
				>
					{isStageMode ? (
						<>
							<div className="flex-1 relative min-h-0 min-w-0">
								{isSplit && screenSharer?.screenShareTrack ? (
									<SplitStage
										leftPanel={
											<ScreenShareView
												screenShareTrack={screenSharer.screenShareTrack}
												sharedByName={screenSharer.displayName || "Unknown"}
												participants={allParticipants}
												showThumbnails={false}
											/>
										}
										rightPanel={
											<WhiteboardPanel
												participants={allParticipants}
												showThumbnails={false}
												theme={theme === "system" ? "auto" : theme}
												onExcalidrawApiReady={onWhiteboardExcalidrawApiReady}
											/>
										}
									/>
									) : enableWhiteboard && isWhiteboardOpen ? (
										<WhiteboardPanel
											participants={allParticipants}
											showThumbnails={false}
											theme={theme === "system" ? "auto" : theme}
											onExcalidrawApiReady={onWhiteboardExcalidrawApiReady}
										/>
									) : (
									<ScreenShareView
										screenShareTrack={screenSharer?.screenShareTrack!}
										sharedByName={screenSharer?.displayName || "Unknown"}
										participants={allParticipants}
										showThumbnails={false}
									/>
								)}

								{/* Stage-wide Collapse Button */}
								{allParticipants.length > 0 && (
									<button
										type="button"
										onClick={() => setIsFilmstripOpen(!isFilmstripOpen)}
										className={cn(
											"absolute z-20 flex items-center justify-center bg-zinc-950/50 backdrop-blur-md border border-white/10 text-white/80 hover:text-white hover:bg-zinc-950/80 transition-all duration-300 shadow-lg",
											layout === "sidebar"
												? "top-1/2 -translate-y-1/2 right-1 w-6 h-12 rounded-l-xl"
												: "left-1/2 -translate-x-1/2 bottom-1 w-12 h-6 rounded-t-xl",
										)}
										aria-label={
											isFilmstripOpen
												? "Collapse filmstrip"
												: "Expand filmstrip"
										}
									>
										{layout === "sidebar" ? (
											isFilmstripOpen ? (
												<ArrowRight01Icon size={16} />
											) : (
												<ArrowLeft01Icon size={16} />
											)
										) : isFilmstripOpen ? (
											<ArrowDown01Icon size={16} />
										) : (
											<ArrowUp01Icon size={16} />
										)}
									</button>
								)}
							</div>

							{/* Unified Filmstrip */}
							{isFilmstripOpen && allParticipants.length > 0 && (
								<div
									className={cn(
										"flex gap-2 transition-all duration-500 ease-in-out",
										layout === "sidebar"
											? "flex-col p-2 w-64 h-full overflow-y-auto border-l border-white/5"
											: "flex-row items-center p-2 h-40 w-full overflow-x-auto overflow-y-hidden scrollbar-none",
									)}
								>
									{allParticipants.map((p, index) => (
										<div
											key={p.id}
											className={cn(
												"shrink-0 relative transition-all duration-300 hover:scale-[1.02]",
												layout === "sidebar"
													? "aspect-video w-full"
													: "aspect-video h-full",
											)}
										>
											<VideoTile
												participant={{
													id: p.id,
													displayName: p.displayName,
													isLocal: p.isLocal,
													isSpeaking: p.isSpeaking,
													isMuted: p.isMuted,
													isVideoEnabled: p.isVideoEnabled,
													isScreenSharing: p.isScreenSharing,
													isHandRaised: p.isHandRaised,
													connectionQuality:
														p.connectionQuality && p.connectionQuality > 0
															? (p.connectionQuality as 1 | 2 | 3 | 4)
															: undefined,
													avatarUrl: p.avatarUrl,
												}}
												videoTrack={p.videoTrack}
												className="w-full h-full chalk-animate-tile-pop"
												style={{ animationDelay: `${index * 100}ms` }}
												showName={true}
												showStatus={true}
											/>
										</div>
									))}
								</div>
							)}
						</>
					) : (
						<VideoGrid
							participants={allParticipants}
							layout={layout}
							variant={isMobile ? "mobile" : "desktop"}
							className="p-4"
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
							"animate-in slide-in-from-right-10 fade-in duration-300",
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
								canManageParticipants={canManageParticipants}
								onMuteParticipant={onToggleParticipantMute}
								onRemoveParticipant={onRemoveParticipant}
								onClose={() => setActivePanel(null)}
								variant="sidebar"
								onAddPeople={handleAddPeople}
								participantVolumes={participantVolumes}
								onParticipantVolumeChange={onParticipantVolumeChange}
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
						canManageParticipants={canManageParticipants}
						onMuteParticipant={onToggleParticipantMute}
						onRemoveParticipant={onRemoveParticipant}
						variant="mobile"
						onAddPeople={handleAddPeople}
						participantVolumes={participantVolumes}
						onParticipantVolumeChange={onParticipantVolumeChange}
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
							isExiting ? "chalk-animate-dock-down" : "chalk-animate-dock-up",
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
			<AudioRenderer
				participants={allParticipants}
				getParticipantVolume={getParticipantVolume}
			/>
		</div>
	);
};

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
