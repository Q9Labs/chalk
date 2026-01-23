import {
	CircleIcon,
	FileTextIcon,
	HandIcon,
	InformationCircleIcon,
	Message01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	Monitor01Icon,
	MonitorOffIcon,
	MoreHorizontalIcon,
	Edit02Icon,
	CallEnd01Icon,
	Settings01Icon,
	SmileIcon,
	ThumbsUpIcon,
	UserGroupIcon,
	Video01Icon,
	VideoOffIcon,
} from "../../utils/icons";
import React from "react";
import { cn } from "../../utils/cn";
import { ControlButton } from "../atomic";

export type ControlBarButton =
	| "mic"
	| "video"
	| "screenshare"
	| "record"
	| "chat"
	| "participants"
	| "transcription"
	| "handraise"
	| "reactions"
	| "whiteboard"
	| "settings"
	| "more"
	| "info"
	| "thumbsup"
	| "leave";

export interface ControlBarProps {
	position?: "bottom" | "top";
	variant?: "floating" | "fixed" | "minimal" | "mobile";
	showLabels?: boolean;
	buttons?: ControlBarButton[];

	isMuted?: boolean;
	isVideoEnabled?: boolean;
	isScreenSharing?: boolean;
	isRecording?: boolean;
	isChatOpen?: boolean;
	isParticipantsOpen?: boolean;
	isTranscriptionEnabled?: boolean;
	isHandRaised?: boolean;
	isWhiteboardOpen?: boolean;
	meetingDuration?: number;

	onToggleMute?: () => void;
	onToggleVideo?: () => void;
	onToggleScreenShare?: () => void;
	onToggleRecording?: () => void;
	onToggleChat?: () => void;
	onToggleParticipants?: () => void;
	onToggleTranscription?: () => void;
	onToggleHandRaise?: () => void;
	onToggleWhiteboard?: () => void;
	onOpenReactions?: () => void;
	onOpenSettings?: () => void;
	onOpenMore?: () => void;
	onOpenInfo?: () => void;
	onLeave?: () => void;

	className?: string;
}

const formatDuration = (seconds: number) => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	}
	return `${minutes}:${String(secs).padStart(2, '0')}`;
};

export const ControlBar = React.memo(
	({
		isMuted = false,
		isVideoEnabled = true,
		isScreenSharing = false,
		isRecording = false,
		isChatOpen = false,
		isParticipantsOpen = false,
		isTranscriptionEnabled = false,
		isHandRaised = false,
		isWhiteboardOpen = false,
		meetingDuration = 0,
		showLabels = false,
		variant = "floating",

		onToggleMute,
		onToggleVideo,
		onToggleScreenShare,
		onToggleRecording,
		onToggleChat,
		onToggleParticipants,
		onToggleTranscription,
		onToggleHandRaise,
		onToggleWhiteboard,
		onOpenReactions,
		onOpenSettings,
		onOpenMore,
		onOpenInfo,
		onLeave,

		className,
	}: ControlBarProps) => {
		const renderButton = (type: ControlBarButton) => {
			switch (type) {
				case "mic":
					return (
						<ControlButton
							key="mic"
							icon={isMuted ? <MicrophoneOff01Icon className="text-[#EF4444]" /> : <Microphone01Icon />}
							label={isMuted ? "Unmute" : "Mute"}
							onClick={onToggleMute}
							active={!isMuted}
							showLabel={showLabels}
							data-tour="controls-mic"
						/>
					);
				case "video":
					return (
						<ControlButton
							key="video"
							icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon className="text-[#EF4444]" />}
							label={isVideoEnabled ? "Stop Video" : "Start Video"}
							onClick={onToggleVideo}
							active={isVideoEnabled}
							showLabel={showLabels}
							data-tour="controls-video"
						/>
					);
				case "screenshare":
					return (
						<ControlButton
							key="screenshare"
							icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />}
							label={isScreenSharing ? "Stop Share" : "Share Screen"}
							onClick={onToggleScreenShare}
							active={isScreenSharing}
							showLabel={showLabels}
							data-tour="controls-screenshare"
						/>
					);
				case "record":
					return (
						<ControlButton
							key="record"
							icon={<CircleIcon className={isRecording ? "fill-current" : ""} />}
							label={isRecording ? "Stop Recording" : "Record"}
							onClick={onToggleRecording}
							active={isRecording}
							showLabel={showLabels}
							data-tour="controls-record"
						/>
					);
				case "chat":
					return (
						<ControlButton
							key="chat"
							icon={<Message01Icon />}
							label="Chat"
							onClick={onToggleChat}
							active={isChatOpen}
							showLabel={showLabels}
							data-tour="controls-chat"
						/>
					);
				case "participants":
					return (
						<ControlButton
							key="participants"
							icon={<UserGroupIcon />}
							label="People"
							onClick={onToggleParticipants}
							active={isParticipantsOpen}
							showLabel={showLabels}
							data-tour="controls-participants"
						/>
					);
				case "transcription":
					return (
						<ControlButton
							key="transcription"
							icon={<FileTextIcon />}
							label="Transcript"
							onClick={onToggleTranscription}
							active={isTranscriptionEnabled}
							showLabel={showLabels}
						/>
					);
				case "handraise":
					return (
						<ControlButton
							key="handraise"
							icon={<HandIcon />}
							label={isHandRaised ? "Lower Hand" : "Raise Hand"}
							onClick={onToggleHandRaise}
							active={isHandRaised}
							showLabel={showLabels}
						/>
					);
				case "reactions":
					return (
						<ControlButton
							key="reactions"
							icon={<SmileIcon />}
							label="Reactions"
							onClick={onOpenReactions}
							showLabel={showLabels}
						/>
					);
				case "whiteboard":
					return (
						<ControlButton
							key="whiteboard"
							icon={<Edit02Icon />}
							label="Whiteboard"
							onClick={onToggleWhiteboard}
							active={isWhiteboardOpen}
							showLabel={showLabels}
						/>
					);
				case "settings":
					return (
						<ControlButton
							key="settings"
							icon={<Settings01Icon size={20} />}
							label="Settings"
							onClick={onOpenSettings}
							noBorder
							showLabel={showLabels}
						/>
					);
				case "more":
					return (
						<ControlButton
							key="more"
							icon={<MoreHorizontalIcon />}
							label="More"
							onClick={onOpenMore}
							showLabel={showLabels}
						/>
					);
				case "leave":
					return null; // Handled explicitly in the layout
				case "info":
					return (
						<ControlButton
							key="info"
							icon={<InformationCircleIcon size={20} />}
							label="Info"
							onClick={onOpenInfo}
							noBorder
						/>
					);
				case "thumbsup":
					return (
						<ControlButton
							key="thumbsup"
							icon={<ThumbsUpIcon size={20} className="text-[#FFD700]" />}
							label="Reactions"
							onClick={onOpenReactions}
							noBorder
						/>
					);
				default:
					return null;
			}
		};

		// Mobile variant: Minimal floating bar with Mic, Video, More, Leave
		if (variant === "mobile") {
			return (
				<div
					className={cn(
						"flex items-center justify-center gap-3 px-4 py-3 rounded-full mx-auto",
						className,
					)}
					style={{
						background: "rgba(0, 0, 0, 0.7)",
						backdropFilter: "blur(12px)",
						WebkitBackdropFilter: "blur(12px)",
						paddingBottom: "max(12px, env(safe-area-inset-bottom))",
					}}
					role="toolbar"
					aria-label="Meeting controls"
				>
					{/* Mic toggle */}
					<button
						type="button"
						onClick={onToggleMute}
						className={cn(
							"flex items-center justify-center w-12 h-12 rounded-full transition-all active:scale-95",
							isMuted ? "bg-red-500/20" : "bg-white/10"
						)}
						aria-label={isMuted ? "Unmute" : "Mute"}
						aria-pressed={!isMuted}
					>
						{isMuted ? (
							<MicrophoneOff01Icon className="w-6 h-6 text-red-500" />
						) : (
							<Microphone01Icon className="w-6 h-6 text-white" />
						)}
					</button>

					{/* Video toggle */}
					<button
						type="button"
						onClick={onToggleVideo}
						className={cn(
							"flex items-center justify-center w-12 h-12 rounded-full transition-all active:scale-95",
							!isVideoEnabled ? "bg-red-500/20" : "bg-white/10"
						)}
						aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
						aria-pressed={isVideoEnabled}
					>
						{isVideoEnabled ? (
							<Video01Icon className="w-6 h-6 text-white" />
						) : (
							<VideoOffIcon className="w-6 h-6 text-red-500" />
						)}
					</button>

					{/* More button */}
					<button
						type="button"
						onClick={onOpenMore}
						className="flex items-center justify-center w-12 h-12 rounded-full bg-white/10 transition-all active:scale-95"
						aria-label="More options"
					>
						<MoreHorizontalIcon className="w-6 h-6 text-white" />
					</button>

					{/* Leave button */}
					<button
						type="button"
						onClick={onLeave}
						className="flex items-center justify-center w-12 h-12 rounded-full bg-red-500 hover:bg-red-600 transition-all active:scale-95"
						aria-label="Leave meeting"
					>
						<CallEnd01Icon className="w-5 h-5 text-white" />
					</button>
				</div>
			);
		}

		return (
			<div
				className={cn(
					"flex items-center justify-between w-full px-6 py-4",
					className,
				)}
				role="toolbar"
				aria-label="Meeting controls"
			>
				{/* Left: Timer section */}
				<div
					className="flex items-center rounded-full px-5 py-2.5 backdrop-blur-md border"
					style={{
						background: "var(--chalk-pill-bg)",
						color: "var(--chalk-pill-text)",
						borderColor: "var(--chalk-pill-border)",
						boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
					}}
				>
					<div className="flex items-center gap-3">
						<div
							className="w-2.5 h-2.5 rounded-full bg-[#22c55e] shadow-[0_0_14px_rgba(34,197,94,0.65)]"
							style={{ outline: "2px solid var(--chalk-pill-dot-ring)", outlineOffset: "2px" }}
						/>
						<span className="text-[14px] font-semibold tracking-wide tabular-nums"
							style={{ color: "var(--chalk-pill-text)" }}
						>
							{formatDuration(meetingDuration)}
						</span>
					</div>
				</div>

				{/* Middle: Media controls */}
				<div className="flex items-center gap-3">
					{renderButton("mic")}
					{renderButton("video")}
					{renderButton("screenshare")}
					{renderButton("whiteboard")}
					{renderButton("handraise")}
					{renderButton("more")}
					<div className="ml-2">
						<ControlButton
							key="leave"
							icon={<CallEnd01Icon size={24} />}
							label="Leave"
							onClick={onLeave}
							danger
							size="lg"
							className="h-12 w-12 rounded-full bg-[#EF4444] hover:bg-[#DC2626] transition-colors shadow-lg"
							data-tour="controls-leave"
						/>
					</div>
				</div>

				{/* Right: Interaction controls */}
				<div className="flex items-center gap-4">
					{renderButton("info")}
					{renderButton("participants")}
					{renderButton("chat")}
					{renderButton("transcription")}
					{renderButton("thumbsup")}
				</div>
			</div>
		);
	},
);

ControlBar.displayName = "ControlBar";
