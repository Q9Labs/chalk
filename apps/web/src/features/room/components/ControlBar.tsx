/**
 * ControlBar - Meeting controls component
 *
 * Contains: mic, video, screen share, recording, layout, hand raise, leave buttons
 * Also: secondary actions (info, participants, chat, reactions, help)
 */

import {
	ControlButton,
	ReactionPicker,
} from "@q9labs/chalk-react";
import {
	Circle,
	Hand,
	HelpCircle,
	Info,
	LayoutTemplate,
	MessageSquare,
	Mic,
	MicOff,
	Monitor,
	MonitorOff,
	MoreHorizontal,
	PhoneOff,
	Square,
	ThumbsUp,
	Users,
	Video,
	VideoOff,
} from "lucide-react";
import { memo, useEffect } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("ControlBar");

interface ControlBarProps {
	// Media state
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
	isScreenSharing: boolean;

	// Recording
	isRecording: boolean;
	recordingDuration: number;
	sessionSeconds: number;

	// UI state
	layout: "grid" | "spotlight";
	isHandRaised: boolean;
	isReactionPickerOpen: boolean;
	activePanel: "chat" | "info" | "participants" | null;
	unreadCount: number;

	// Actions
	onToggleVideo: () => void;
	onToggleAudio: () => void;
	onStartScreenShare: () => void;
	onStopScreenShare: () => void;
	onStartRecording: () => void;
	onStopRecording: () => void;
	onToggleLayout: () => void;
	onHandRaise: () => void;
	onLeave: () => void;
	onTogglePanel: (panel: "chat" | "info" | "participants") => void;
	onSetReactionPickerOpen: (open: boolean) => void;
	onSendReaction: (emoji: string) => void;
	onShowTour: () => void;

	// Sound effects
	playClick: () => void;
	playRecordingStart: () => void;
	playRecordingStop: () => void;
}

export const ControlBar = memo(function ControlBar({
	isVideoEnabled,
	isAudioEnabled,
	isScreenSharing,
	isRecording,
	recordingDuration,
	sessionSeconds,
	layout,
	isHandRaised,
	isReactionPickerOpen,
	activePanel,
	unreadCount,
	onToggleVideo,
	onToggleAudio,
	onStartScreenShare,
	onStopScreenShare,
	onStartRecording,
	onStopRecording,
	onToggleLayout,
	onHandRaise,
	onLeave,
	onTogglePanel,
	onSetReactionPickerOpen,
	onSendReaction,
	onShowTour,
	playClick,
	playRecordingStart,
	playRecordingStop,
}: ControlBarProps) {
	// ==========================================================================
	// LIFECYCLE & DEBUG
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		return () => log.lifecycle("unmount");
	}, []);

	useEffect(() => {
		log.debug("Media State", {
			video: isVideoEnabled,
			audio: isAudioEnabled,
			screen: isScreenSharing,
			recording: isRecording,
		});
	}, [isVideoEnabled, isAudioEnabled, isScreenSharing, isRecording]);

	useEffect(() => {
		log.debug("UI State", {
			layout,
			isHandRaised,
			activePanel,
			unreadCount,
		});
	}, [layout, isHandRaised, activePanel, unreadCount]);

	// ==========================================================================
	// HANDLERS WITH LOGGING
	// ==========================================================================

	const handleToggleAudio = () => {
		log.action("mic", "Toggle audio", isAudioEnabled ? "muting" : "unmuting");
		playClick();
		onToggleAudio();
	};

	const handleToggleVideo = () => {
		log.action("video", "Toggle video", isVideoEnabled ? "stopping" : "starting");
		playClick();
		onToggleVideo();
	};

	const handleToggleScreenShare = () => {
		log.action("screen", "Toggle screen share", isScreenSharing ? "stopping" : "starting");
		playClick();
		if (isScreenSharing) {
			onStopScreenShare();
		} else {
			onStartScreenShare();
		}
	};

	const handleToggleRecording = () => {
		if (isRecording) {
			log.action("recording", "Stop recording", `duration=${recordingDuration}s`);
			playRecordingStop();
			onStopRecording();
		} else {
			log.action("recording", "Start recording");
			playRecordingStart();
			onStartRecording();
		}
	};

	const handleToggleLayout = () => {
		log.action("toggle", "Toggle layout", layout === "grid" ? "spotlight" : "grid");
		playClick();
		onToggleLayout();
	};

	const handleHandRaise = () => {
		log.action("hand", isHandRaised ? "Lower hand" : "Raise hand");
		onHandRaise();
	};

	const handleLeave = () => {
		log.action("leave", "Leave meeting clicked");
		onLeave();
	};

	const handleTogglePanel = (panel: "chat" | "info" | "participants") => {
		log.action("toggle", `Toggle ${panel} panel`, activePanel === panel ? "closing" : "opening");
		onTogglePanel(panel);
	};

	const handleReactionPickerToggle = () => {
		log.action("toggle", "Reaction picker", isReactionPickerOpen ? "closing" : "opening");
		onSetReactionPickerOpen(!isReactionPickerOpen);
	};

	const handleShowTour = () => {
		log.action("click", "Show tour");
		onShowTour();
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

	return (
		<div className="h-24 flex items-center justify-center px-6 relative z-50">
			<div className="flex items-center w-full mx-auto">
				{/* Left: Timer */}
				<div
					className="hidden md:flex items-center gap-3 bg-white/5 backdrop-blur-3xl border border-white/10 rounded-full px-5 py-3 min-w-[160px] justify-center shadow-[0_8px_32px_0_rgba(0,0,0,0.36)] ring-1 ring-white/5 transition-transform hover:scale-105 cursor-pointer"
					onClick={handleToggleRecording}
				>
					<div
						className={`w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${isRecording ? "bg-red-500 text-red-500 animate-pulse" : "bg-green-500 text-green-500"}`}
					/>
					<span className="text-sm font-semibold tracking-wide text-white/90">
						{isRecording
							? formatDuration(recordingDuration)
							: formatDuration(sessionSeconds)}
					</span>
				</div>

				{/* Center: Main Controls */}
				<div className="flex items-center gap-2 md:gap-4 bg-white/3 backdrop-blur-3xl border border-white/10 rounded-full px-4 md:px-6 py-2 md:py-3 shadow-[0_8px_32px_0_rgba(0,0,0,0.36)] mx-auto ring-1 ring-white/5 transition-all hover:bg-white/10 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.45)]">
					<ControlButton
						icon={isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
						onClick={handleToggleAudio}
						className={`transition-all duration-300 ${!isAudioEnabled ? "bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]" : "bg-transparent hover:bg-white/10 text-white"}`}
						size="md"
						label={isAudioEnabled ? "Mute" : "Unmute"}
						data-tour="controls-mic"
					/>
					<ControlButton
						icon={
							isVideoEnabled ? <Video size={20} /> : <VideoOff size={20} />
						}
						onClick={handleToggleVideo}
						className={`transition-all duration-300 ${!isVideoEnabled ? "bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]" : "bg-transparent hover:bg-white/10 text-white"}`}
						size="md"
						label={isVideoEnabled ? "Stop Video" : "Start Video"}
						data-tour="controls-video"
					/>
					<ControlButton
						icon={
							isScreenSharing ? (
								<MonitorOff size={20} />
							) : (
								<Monitor size={20} />
							)
						}
						onClick={handleToggleScreenShare}
						className={`transition-all duration-300 ${isScreenSharing ? "bg-purple-500/80 text-white shadow-[0_0_15px_rgba(168,85,247,0.5)]" : "bg-transparent hover:bg-white/10 text-white"}`}
						size="md"
						label="Share Screen"
						data-tour="controls-screenshare"
					/>
					<div className="w-px h-8 bg-white/10 mx-1" />
					<ControlButton
						icon={
							isRecording ? (
								<Square size={18} fill="currentColor" />
							) : (
								<Circle size={20} fill="currentColor" />
							)
						}
						onClick={handleToggleRecording}
						className={`transition-all duration-300 ${isRecording ? "bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse" : "bg-transparent hover:bg-white/10 text-red-400"}`}
						size="md"
						label={isRecording ? "Stop Recording" : "Record"}
					/>
					<ControlButton
						icon={<LayoutTemplate size={20} />}
						onClick={handleToggleLayout}
						className={`transition-all duration-300 ${layout === "spotlight" ? "bg-white/20" : "bg-transparent hover:bg-white/10"} text-white`}
						size="md"
						label={layout === "grid" ? "Spotlight" : "Grid"}
					/>
					<ControlButton
						icon={<Hand size={20} />}
						onClick={handleHandRaise}
						className={`transition-all duration-300 ${isHandRaised ? "bg-yellow-500/80 text-white shadow-[0_0_15px_rgba(234,179,8,0.5)]" : "bg-transparent hover:bg-white/10 text-white"}`}
						size="md"
						label={isHandRaised ? "Lower Hand" : "Raise Hand"}
						data-tour="controls-hand"
					/>
					<ControlButton
						icon={<MoreHorizontal size={20} />}
						onClick={() => {
							log.action("click", "More options");
							playClick();
						}}
						className="bg-transparent hover:bg-white/10 text-white transition-all duration-300"
						size="md"
						label="More"
					/>
					<ControlButton
						icon={<PhoneOff size={20} />}
						onClick={handleLeave}
						className="bg-red-500/90 text-white hover:bg-red-600 shadow-[0_4px_15px_rgba(239,68,68,0.4)] ml-2 backdrop-blur-md border border-red-400/20"
						size="md"
						label="Leave"
						danger
						data-tour="controls-leave"
					/>
				</div>

				{/* Right: Secondary Actions */}
				<div className="hidden md:flex items-center gap-2">
					<ControlButton
						icon={<Info size={20} />}
						onClick={() => handleTogglePanel("info")}
						className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === "info" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
						size="sm"
						label="Info"
					/>
					<ControlButton
						icon={<Users size={20} />}
						onClick={() => handleTogglePanel("participants")}
						className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === "participants" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
						size="sm"
						label="People"
						data-tour="controls-participants"
					/>
					<div className="relative">
						<ControlButton
							icon={<MessageSquare size={20} />}
							onClick={() => handleTogglePanel("chat")}
							className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === "chat" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
							size="sm"
							label="Chat"
							data-tour="controls-chat"
						/>
						{unreadCount > 0 && (
							<span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
								{unreadCount > 99 ? "99+" : unreadCount}
							</span>
						)}
					</div>
					<div className="relative">
						<ControlButton
							icon={<ThumbsUp size={20} />}
							onClick={handleReactionPickerToggle}
							className={`backdrop-blur-xl border border-white/10 rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${isReactionPickerOpen ? "bg-white/20 text-yellow-400" : "bg-white/5 hover:bg-white/10 text-yellow-500"}`}
							size="sm"
							label="Reactions"
							data-tour="reactions-button"
						/>
						<ReactionPicker
							isOpen={isReactionPickerOpen}
							onClose={() => onSetReactionPickerOpen(false)}
							onSelect={onSendReaction}
							position="top"
						/>
					</div>
					<ControlButton
						icon={<HelpCircle size={20} />}
						onClick={handleShowTour}
						className="bg-white/5 backdrop-blur-xl border border-white/10 hover:bg-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)]"
						size="sm"
						label="Help"
					/>
				</div>
			</div>
		</div>
	);
});
