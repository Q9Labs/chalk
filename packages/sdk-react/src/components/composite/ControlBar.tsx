import {
	Circle,
	FileText,
	Hand,
	Info,
	MessageSquare,
	Mic,
	MicOff,
	Monitor,
	MonitorOff,
	MoreHorizontal,
	PenTool,
	PhoneOff,
	Settings,
	Smile,
	ThumbsUp,
	Users,
	Video,
	VideoOff,
} from "lucide-react";
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
	variant?: "floating" | "fixed" | "minimal";
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
							icon={isMuted ? <MicOff className="text-[#EF4444]" /> : <Mic />}
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
							icon={isVideoEnabled ? <Video /> : <VideoOff className="text-[#EF4444]" />}
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
							icon={isScreenSharing ? <MonitorOff /> : <Monitor />}
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
							icon={<Circle className={isRecording ? "fill-current" : ""} />}
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
							icon={<MessageSquare />}
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
							icon={<Users />}
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
							icon={<FileText />}
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
							icon={<Hand />}
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
							icon={<Smile />}
							label="Reactions"
							onClick={onOpenReactions}
							showLabel={showLabels}
						/>
					);
				case "whiteboard":
					return (
						<ControlButton
							key="whiteboard"
							icon={<PenTool />}
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
							icon={<Settings size={20} />}
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
							icon={<MoreHorizontal />}
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
							icon={<Info size={20} />}
							label="Info"
							onClick={onOpenInfo}
							noBorder
						/>
					);
				case "thumbsup":
					return (
						<ControlButton
							key="thumbsup"
							icon={<ThumbsUp size={20} className="text-[#FFD700]" />}
							label="Reactions"
							onClick={onOpenReactions}
							noBorder
						/>
					);
				default:
					return null;
			}
		};

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
				<div className="flex items-center bg-[#1A1A1A] rounded-full px-5 py-2.5">
					<div className="flex items-center gap-3">
						<div className="w-2 h-2 rounded-full bg-[#151515] shadow-[0_0_8px_rgba(21,21,21,0.5)]" />
						<span className="text-white text-[14px] font-medium tracking-wide tabular-nums opacity-90">
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
							icon={<PhoneOff size={24} />}
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
