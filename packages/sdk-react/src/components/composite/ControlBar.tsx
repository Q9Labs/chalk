import type { MediaDevice } from "@q9labs/chalk-core";
import React, { useMemo } from "react";
import { cn } from "../../utils/cn";
import {
	CallEnd01Icon,
	CircleIcon,
	Edit02Icon,
	FileTextIcon,
	HandIcon,
	InformationCircleIcon,
	Message01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	Monitor01Icon,
	MonitorOffIcon,
	MoreHorizontalIcon,
	Settings01Icon,
	SmileIcon,
	ThumbsUpIcon,
	UserGroupIcon,
	Video01Icon,
	VideoOffIcon,
} from "../../utils/icons";
import { ControlButton, Select } from "../atomic";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";

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
	variant?: "floating" | "fixed" | "minimal" | "mobile" | "dock";
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
	unreadChatCount?: number;
	audioInputDevices?: readonly MediaDevice[];
	audioOutputDevices?: readonly MediaDevice[];
	videoInputDevices?: readonly MediaDevice[];
	selectedAudioInput?: string;
	selectedAudioOutput?: string;
	selectedVideoInput?: string;

	onToggleMute?: () => void;
	onToggleVideo?: () => void;
	onAudioInputChange?: (deviceId: string) => void;
	onAudioOutputChange?: (deviceId: string) => void;
	onVideoInputChange?: (deviceId: string) => void;
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

	participantColorSeed?: string;
	className?: string;
}

interface InlineDevicePickerProps {
	label: string;
	devices?: readonly MediaDevice[];
	value?: string;
	onChange?: (deviceId: string) => void;
	placeholder: string;
}

function InlineDevicePicker({
	label,
	devices = [],
	value,
	onChange,
	placeholder,
}: InlineDevicePickerProps) {
	if (!onChange || devices.length === 0) {
		return null;
	}

	return (
		<div className="flex items-center gap-2 rounded-full bg-white/70 dark:bg-zinc-900/70 px-2.5 py-1">
			<span className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
				{label}
			</span>
			<Select
				options={devices.map((device) => ({
					label: device.label || placeholder,
					value: device.deviceId,
				}))}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				size="sm"
				placeholder={placeholder}
				className="w-[160px] border-black/10 bg-white/90 text-sm dark:border-white/10 dark:bg-zinc-950/90"
			/>
		</div>
	);
}

const formatDuration = (seconds: number) => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${minutes}:${String(secs).padStart(2, "0")}`;
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
		unreadChatCount = 0,
		audioInputDevices,
		audioOutputDevices,
		videoInputDevices,
		selectedAudioInput,
		selectedAudioOutput,
		selectedVideoInput,
		showLabels = false,
		variant = "floating",
		buttons,

		onToggleMute,
		onToggleVideo,
		onAudioInputChange,
		onAudioOutputChange,
		onVideoInputChange,
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
		participantColorSeed,

		className,
	}: ControlBarProps) => {
		const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);
		const defaultButtons: ControlBarButton[] = [
			"mic",
			"video",
			"screenshare",
			"whiteboard",
			"handraise",
			"leave",
			"participants",
			"chat",
			"transcription",
			"thumbsup",
			"settings",
		];

		const buttonsToRender = buttons ?? defaultButtons;
		const showLeave = buttonsToRender.includes("leave");
		const mediaButtons = buttonsToRender.filter((b) =>
			b === "mic" ||
			b === "video" ||
			b === "screenshare" ||
			b === "record" ||
			b === "whiteboard" ||
			b === "handraise"
		);
		const interactionButtons = buttonsToRender.filter((b) =>
			b === "participants" ||
			b === "chat" ||
			b === "transcription" ||
			b === "thumbsup" ||
			b === "reactions" ||
			b === "settings" ||
			b === "more" ||
			b === "info"
		);

		const renderButton = (type: ControlBarButton) => {
			switch (type) {
				case "mic":
					return (
						<ControlButton
							key="mic"
							icon={
								isMuted ? (
									<MicrophoneOff01Icon className="text-[#dc2626]" />
								) : (
									<Microphone01Icon />
								)
							}
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
							icon={
								isVideoEnabled ? (
									<Video01Icon />
								) : (
									<VideoOffIcon className="text-[#dc2626]" />
								)
							}
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
							showLabel={showLabels}
							data-tour="controls-screenshare"
						/>
					);
				case "record":
					return (
						<ControlButton
							key="record"
							icon={
								<CircleIcon className={isRecording ? "fill-current" : ""} />
							}
							label={isRecording ? "Stop Recording" : "Record"}
							onClick={onToggleRecording}
							active={isRecording}
							showLabel={showLabels}
							data-tour="controls-record"
						/>
					);
				case "chat":
					return (
						<div key="chat" className="relative">
							<ControlButton
								icon={<Message01Icon />}
								label="Chat"
								onClick={onToggleChat}
								active={isChatOpen}
								activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
								showLabel={showLabels}
								data-tour="controls-chat"
							/>
							{unreadChatCount > 0 && !isChatOpen && (
								<span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-white bg-[#dc2626] rounded-full shadow-sm">
									{unreadChatCount > 99 ? "99+" : unreadChatCount}
								</span>
							)}
						</div>
					);
				case "participants":
					return (
						<ControlButton
							key="participants"
							icon={<UserGroupIcon />}
							label="People"
							onClick={onToggleParticipants}
							active={isParticipantsOpen}
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
							activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
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
						...(themeVariables as React.CSSProperties),
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
							isMuted ? "bg-red-500/20" : "bg-white/10",
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
							!isVideoEnabled ? "bg-red-500/20" : "bg-white/10",
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
						className="flex items-center justify-center w-12 h-12 rounded-full bg-[#dc2626] hover:bg-[#b91c1c] transition-all active:scale-95"
						aria-label="Leave meeting"
					>
						<CallEnd01Icon className="w-5 h-5 text-white" />
					</button>
				</div>
			);
		}

		if (variant === "dock") {
			return (
				<div className="relative flex items-end justify-center w-full pointer-events-none">
					{/* Left: Timer section - Absolute positioned */}
					<div className="absolute left-6 bottom-3 flex items-center rounded-full px-3 py-1.5 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-lg pointer-events-auto">
						<div className="flex items-center gap-2">
							<div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
							<span className="text-xs font-medium tracking-wide tabular-nums text-zinc-900 dark:text-white/90">
								{formatDuration(meetingDuration)}
							</span>
						</div>
					</div>

					{/* Center: Main Dock */}
					<div
						className={cn(
							"flex items-center justify-between gap-4 px-6 pt-2 pb-2 rounded-t-[2.5rem] rounded-b-none backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.2)] dark:shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.5)] pointer-events-auto",
							"bg-white/90 dark:bg-zinc-950/90",
							className,
						)}
						style={themeVariables as React.CSSProperties}
						role="toolbar"
						aria-label="Meeting controls"
					>
						{/* Middle: Media controls */}
						<div className="flex items-center gap-1.5">
							<div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
								{renderButton("mic")}
								<InlineDevicePicker
									label="Mic"
									devices={audioInputDevices}
									value={selectedAudioInput}
									onChange={onAudioInputChange}
									placeholder="Select microphone"
								/>
								<InlineDevicePicker
									label="Speaker"
									devices={audioOutputDevices}
									value={selectedAudioOutput}
									onChange={onAudioOutputChange}
									placeholder="Select speaker"
								/>
							</div>

							<div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
								{renderButton("video")}
								<InlineDevicePicker
									label="Cam"
									devices={videoInputDevices}
									value={selectedVideoInput}
									onChange={onVideoInputChange}
									placeholder="Select camera"
								/>
							</div>

							<div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
								{renderButton("screenshare")}
								{renderButton("whiteboard")}
								{renderButton("handraise")}
							</div>

							<div className="ml-1">
								<ControlButton
									key="leave"
									icon={<CallEnd01Icon size={20} />}
									label="Leave"
									onClick={onLeave}
									danger
									className="h-10 w-auto px-5 rounded-full hover:scale-105 transition-transform shadow-lg"
									data-tour="controls-leave"
								/>
							</div>
						</div>

						{/* Divider */}
						<div className="w-px h-8 bg-black/10 dark:bg-white/10" />

						{/* Right: Interaction controls */}
						<div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
							{renderButton("participants")}
							{renderButton("chat")}
							{renderButton("transcription")}
							{renderButton("thumbsup")}
							{renderButton("settings")}
						</div>
					</div>
				</div>
			);
		}

		return (
			<div
				className={cn(
					"flex items-center justify-between w-full px-6 py-4",
					className,
				)}
				style={themeVariables as React.CSSProperties}
				role="toolbar"
				aria-label="Meeting controls"
			>
				{/* Left: Timer section */}
				<div
					className="flex items-center rounded-full px-5 py-2.5 backdrop-blur-md border"
					style={{
						background: "var(--chalk-bg-glass, var(--chalk-pill-bg))",
						color: "var(--chalk-pill-text)",
						borderColor: "var(--chalk-border-subtle, var(--chalk-pill-border))",
						boxShadow: "var(--chalk-shadow-2, 0 10px 30px rgba(0,0,0,0.25))",
					}}
				>
					<div className="flex items-center gap-3">
						<div
							className="w-2.5 h-2.5 rounded-full bg-[#22c55e] shadow-[0_0_14px_rgba(34,197,94,0.65)]"
							style={{
								outline: "2px solid var(--chalk-pill-dot-ring)",
								outlineOffset: "2px",
							}}
						/>
						<span
							className="text-[14px] font-semibold tracking-wide tabular-nums"
							style={{ color: "var(--chalk-pill-text)" }}
						>
							{formatDuration(meetingDuration)}
						</span>
					</div>
				</div>

				{/* Middle: Media controls */}
				<div className="flex items-center gap-3">
					{mediaButtons.map(renderButton)}
					{showLeave && (
						<div className="ml-2">
							<ControlButton
								key="leave"
								icon={<CallEnd01Icon size={20} />}
								label="Leave"
								onClick={onLeave}
								danger
								data-tour="controls-leave"
							/>
						</div>
					)}
				</div>

				{/* Right: Interaction controls */}
				<div className="flex items-center gap-4">
					{interactionButtons.map(renderButton)}
				</div>
			</div>
		);
	},
);

ControlBar.displayName = "ControlBar";
