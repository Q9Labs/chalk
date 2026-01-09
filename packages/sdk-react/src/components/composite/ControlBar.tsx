import {
	Circle,
	FileText,
	Hand,
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
	onLeave?: () => void;

	className?: string;
}

const DEFAULT_BUTTONS: ControlBarButton[] = [
	"mic",
	"video",
	"screenshare",
	"chat",
	"reactions",
	"whiteboard",
	"leave",
];

export const ControlBar = React.memo(
	({
		position: _position = "bottom",
		variant = "floating",
		showLabels = false,
		buttons = DEFAULT_BUTTONS,

		isMuted = false,
		isVideoEnabled = true,
		isScreenSharing = false,
		isRecording = false,
		isChatOpen = false,
		isParticipantsOpen = false,
		isTranscriptionEnabled = false,
		isHandRaised = false,
		isWhiteboardOpen = false,

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
		onLeave,

		className,
	}: ControlBarProps) => {
		const renderButton = (type: ControlBarButton) => {
			switch (type) {
				case "mic":
					return (
						<ControlButton
							key="mic"
							icon={isMuted ? <MicOff /> : <Mic />}
							label={isMuted ? "Unmute" : "Mute"}
							onClick={onToggleMute}
							danger={isMuted}
							showLabel={showLabels}
							data-tour="controls-mic"
						/>
					);
				case "video":
					return (
						<ControlButton
							key="video"
							icon={isVideoEnabled ? <Video /> : <VideoOff />}
							label={isVideoEnabled ? "Stop Video" : "Start Video"}
							onClick={onToggleVideo}
							danger={!isVideoEnabled}
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
							icon={<Settings />}
							label="Settings"
							onClick={onOpenSettings}
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
					return (
						<button
							key="leave"
							type="button"
							onClick={onLeave}
							className="ml-2 flex items-center gap-2 px-6 h-10 rounded-full bg-[#ea4335] hover:bg-[#d93025] text-white font-medium transition-colors"
							aria-label="Leave meeting"
							data-tour="controls-leave"
						>
							<PhoneOff size={20} />
							{showLabels && <span>Leave</span>}
						</button>
					);
				default:
					return null;
			}
		};

		return (
			<div
				className={cn(
					"flex items-center justify-center gap-3 p-3 transition-all duration-300",
					variant === "floating" && "rounded-2xl bg-[#121212] shadow-lg border border-[#303134]",
					variant === "fixed" && "w-full bg-[#121212] border-t border-[#303134]",
					variant === "minimal" && "bg-transparent",
					className,
				)}
				role="toolbar"
				aria-label="Meeting controls"
			>
				{buttons.map(renderButton)}
			</div>
		);
	},
);

ControlBar.displayName = "ControlBar";
