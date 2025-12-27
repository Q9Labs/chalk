/**
 * Controls component - Media control buttons for video calls
 */

import type { CSSProperties, ReactNode } from "react";
import { useMedia } from "../hooks/useMedia.ts";
import { useRecording } from "../hooks/useRecording.ts";

export interface ControlsProps {
	/** Additional CSS class names */
	className?: string;
	/** Inline styles */
	style?: CSSProperties;
	/** Called when leave button is clicked */
	onLeave?: () => void;
	/** Show audio toggle button */
	showAudio?: boolean;
	/** Show video toggle button */
	showVideo?: boolean;
	/** Show screen share button */
	showScreenShare?: boolean;
	/** Show recording button (host only) */
	showRecording?: boolean;
	/** Show leave button */
	showLeave?: boolean;
	/** Custom button renderer */
	renderButton?: (props: ControlButtonProps) => ReactNode;
	/** Button size in pixels */
	buttonSize?: number;
	/** Layout direction */
	direction?: "horizontal" | "vertical";
}

export interface ControlButtonProps {
	/** Button type */
	type: "audio" | "video" | "screenShare" | "recording" | "leave";
	/** Whether the control is active/enabled */
	isActive: boolean;
	/** Click handler */
	onClick: () => void;
	/** Accessibility label */
	label: string;
	/** Icon to display */
	icon: string;
	/** Whether the button is disabled */
	disabled?: boolean;
}

/**
 * Controls - Pre-built control bar for media controls
 *
 * @example
 * ```tsx
 * // Basic usage
 * <Controls onLeave={() => room.leave()} />
 *
 * // Selective controls
 * <Controls
 *   showAudio={true}
 *   showVideo={true}
 *   showScreenShare={false}
 *   showRecording={isHost}
 *   onLeave={handleLeave}
 * />
 *
 * // Custom button renderer
 * <Controls
 *   renderButton={({ type, isActive, onClick, label }) => (
 *     <MyButton active={isActive} onClick={onClick} aria-label={label} />
 *   )}
 * />
 * ```
 */
export function Controls({
	className,
	style,
	onLeave,
	showAudio = true,
	showVideo = true,
	showScreenShare = true,
	showRecording = false,
	showLeave = true,
	renderButton,
	buttonSize = 48,
	direction = "horizontal",
}: ControlsProps) {
	const {
		isAudioEnabled,
		isVideoEnabled,
		isScreenSharing,
		toggleAudio,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
	} = useMedia();

	const { isRecording, startRecording, stopRecording } = useRecording();

	const containerStyle: CSSProperties = {
		display: "flex",
		flexDirection: direction === "horizontal" ? "row" : "column",
		gap: "12px",
		padding: "16px",
		backgroundColor: "rgba(0, 0, 0, 0.8)",
		borderRadius: "12px",
		alignItems: "center",
		justifyContent: "center",
		...style,
	};

	const buttonStyle = (
		isActive: boolean,
		isDestructive = false,
	): CSSProperties => ({
		width: `${buttonSize}px`,
		height: `${buttonSize}px`,
		borderRadius: "50%",
		border: "none",
		cursor: "pointer",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		fontSize: `${buttonSize * 0.45}px`,
		transition: "all 0.2s ease",
		backgroundColor: isDestructive
			? "#ef4444"
			: isActive
				? "#4a5568"
				: "#ef4444",
		color: "white",
	});

	const buttons: ControlButtonProps[] = [];

	if (showAudio) {
		buttons.push({
			type: "audio",
			isActive: isAudioEnabled,
			onClick: () => toggleAudio(),
			label: isAudioEnabled ? "Mute microphone" : "Unmute microphone",
			icon: isAudioEnabled ? "🎤" : "🔇",
		});
	}

	if (showVideo) {
		buttons.push({
			type: "video",
			isActive: isVideoEnabled,
			onClick: () => toggleVideo(),
			label: isVideoEnabled ? "Turn off camera" : "Turn on camera",
			icon: isVideoEnabled ? "📹" : "📵",
		});
	}

	if (showScreenShare) {
		buttons.push({
			type: "screenShare",
			isActive: isScreenSharing,
			onClick: () => (isScreenSharing ? stopScreenShare() : startScreenShare()),
			label: isScreenSharing ? "Stop sharing" : "Share screen",
			icon: isScreenSharing ? "🖥️" : "🖥️",
		});
	}

	if (showRecording) {
		buttons.push({
			type: "recording",
			isActive: isRecording,
			onClick: () => (isRecording ? stopRecording() : startRecording()),
			label: isRecording ? "Stop recording" : "Start recording",
			icon: isRecording ? "⏹️" : "⏺️",
		});
	}

	if (showLeave && onLeave) {
		buttons.push({
			type: "leave",
			isActive: false,
			onClick: onLeave,
			label: "Leave call",
			icon: "📞",
		});
	}

	const defaultButtonRender = (props: ControlButtonProps) => (
		<button
			key={props.type}
			onClick={props.onClick}
			aria-label={props.label}
			title={props.label}
			style={buttonStyle(props.isActive, props.type === "leave")}
			disabled={props.disabled}
		>
			{props.icon}
		</button>
	);

	return (
		<div className={`chalk-controls ${className ?? ""}`} style={containerStyle}>
			{buttons.map((btn) =>
				renderButton ? renderButton(btn) : defaultButtonRender(btn),
			)}
		</div>
	);
}
