/**
 * ControlBar - Horizontal bar with meeting control buttons
 */

import { useMemo } from "react";
import {
	View,
	TouchableOpacity,
	StyleSheet,
	type ViewStyle,
} from "react-native";

interface ControlBarProps {
	/** Callback when audio toggle pressed */
	onToggleAudio?: () => void;
	/** Callback when video toggle pressed */
	onToggleVideo?: () => void;
	/** Callback when screen share toggle pressed */
	onToggleScreenShare?: () => void;
	/** Callback when chat toggle pressed */
	onToggleChat?: () => void;
	/** Callback when leave pressed */
	onLeave?: () => void;
	/** Whether audio is currently enabled */
	isAudioEnabled?: boolean;
	/** Whether video is currently enabled */
	isVideoEnabled?: boolean;
	/** Whether screen sharing is active */
	isScreenSharing?: boolean;
	/** Whether chat panel is open */
	isChatOpen?: boolean;
	/** Additional container styles */
	style?: ViewStyle;
}

const ICON_SIZE = 24;
const BUTTON_SIZE = 48;

/**
 * Microphone icon - filled when active, outlined with slash when muted
 */
function MicIcon({ active }: { active: boolean }) {
	const micWidth = ICON_SIZE * 0.35;
	const micHeight = ICON_SIZE * 0.5;

	if (active) {
		return (
			<View style={iconStyles.container}>
				{/* Mic body - filled */}
				<View
					style={{
						width: micWidth,
						height: micHeight,
						backgroundColor: "#ffffff",
						borderRadius: micWidth / 2,
					}}
				/>
				{/* Arc holder */}
				<View
					style={{
						width: micWidth * 1.6,
						height: micHeight * 0.5,
						borderWidth: 2,
						borderColor: "#ffffff",
						borderTopWidth: 0,
						borderBottomLeftRadius: micWidth,
						borderBottomRightRadius: micWidth,
						marginTop: -micHeight * 0.15,
					}}
				/>
				{/* Stand */}
				<View
					style={{
						width: 2,
						height: ICON_SIZE * 0.15,
						backgroundColor: "#ffffff",
					}}
				/>
			</View>
		);
	}

	// Muted state - outlined with slash
	return (
		<View style={iconStyles.container}>
			{/* Mic body - outlined */}
			<View
				style={{
					width: micWidth,
					height: micHeight,
					borderWidth: 2,
					borderColor: "#ffffff",
					borderRadius: micWidth / 2,
					backgroundColor: "transparent",
				}}
			/>
			{/* Arc holder */}
			<View
				style={{
					width: micWidth * 1.6,
					height: micHeight * 0.5,
					borderWidth: 2,
					borderColor: "#ffffff",
					borderTopWidth: 0,
					borderBottomLeftRadius: micWidth,
					borderBottomRightRadius: micWidth,
					marginTop: -micHeight * 0.15,
				}}
			/>
			{/* Stand */}
			<View
				style={{
					width: 2,
					height: ICON_SIZE * 0.15,
					backgroundColor: "#ffffff",
				}}
			/>
			{/* Diagonal slash */}
			<View
				style={[
					iconStyles.slash,
					{
						width: 2,
						height: ICON_SIZE * 1.1,
						backgroundColor: "#ffffff",
						transform: [{ rotate: "45deg" }],
					},
				]}
			/>
		</View>
	);
}

/**
 * Video camera icon - filled when active, outlined with slash when off
 */
function VideoIcon({ active }: { active: boolean }) {
	const bodyWidth = ICON_SIZE * 0.5;
	const bodyHeight = ICON_SIZE * 0.4;

	if (active) {
		return (
			<View style={iconStyles.rowContainer}>
				{/* Camera body - filled */}
				<View
					style={{
						width: bodyWidth,
						height: bodyHeight,
						backgroundColor: "#ffffff",
						borderRadius: 3,
					}}
				/>
				{/* Lens triangle */}
				<View
					style={{
						width: 0,
						height: 0,
						borderLeftWidth: ICON_SIZE * 0.2,
						borderLeftColor: "#ffffff",
						borderTopWidth: ICON_SIZE * 0.15,
						borderTopColor: "transparent",
						borderBottomWidth: ICON_SIZE * 0.15,
						borderBottomColor: "transparent",
						marginLeft: 2,
					}}
				/>
			</View>
		);
	}

	// Video off - outlined with slash
	return (
		<View style={iconStyles.rowContainer}>
			{/* Camera body - outlined */}
			<View
				style={{
					width: bodyWidth,
					height: bodyHeight,
					borderWidth: 2,
					borderColor: "#ffffff",
					borderRadius: 3,
					backgroundColor: "transparent",
				}}
			/>
			{/* Lens triangle */}
			<View
				style={{
					width: 0,
					height: 0,
					borderLeftWidth: ICON_SIZE * 0.2,
					borderLeftColor: "#ffffff",
					borderTopWidth: ICON_SIZE * 0.15,
					borderTopColor: "transparent",
					borderBottomWidth: ICON_SIZE * 0.15,
					borderBottomColor: "transparent",
					marginLeft: 2,
				}}
			/>
			{/* Diagonal slash */}
			<View
				style={[
					iconStyles.slash,
					{
						width: 2,
						height: ICON_SIZE * 1.1,
						backgroundColor: "#ffffff",
						transform: [{ rotate: "45deg" }],
					},
				]}
			/>
		</View>
	);
}

/**
 * Screen share icon - monitor with arrow
 */
function ScreenShareIcon({ active }: { active: boolean }) {
	const monitorWidth = ICON_SIZE * 0.7;
	const monitorHeight = ICON_SIZE * 0.5;

	return (
		<View style={iconStyles.container}>
			{/* Monitor frame */}
			<View
				style={{
					width: monitorWidth,
					height: monitorHeight,
					borderWidth: 2,
					borderColor: "#ffffff",
					borderRadius: 2,
					backgroundColor: active ? "#ffffff" : "transparent",
					justifyContent: "center",
					alignItems: "center",
				}}
			>
				{/* Arrow up */}
				<View
					style={{
						width: 0,
						height: 0,
						borderLeftWidth: 5,
						borderLeftColor: "transparent",
						borderRightWidth: 5,
						borderRightColor: "transparent",
						borderBottomWidth: 6,
						borderBottomColor: active ? "#3b82f6" : "#ffffff",
					}}
				/>
			</View>
			{/* Stand */}
			<View
				style={{
					width: monitorWidth * 0.4,
					height: 2,
					backgroundColor: "#ffffff",
					marginTop: 2,
				}}
			/>
		</View>
	);
}

/**
 * Chat bubble icon - filled when active
 */
function ChatIcon({ active }: { active: boolean }) {
	const bubbleWidth = ICON_SIZE * 0.65;
	const bubbleHeight = ICON_SIZE * 0.5;

	return (
		<View style={iconStyles.container}>
			{/* Chat bubble */}
			<View
				style={{
					width: bubbleWidth,
					height: bubbleHeight,
					borderWidth: 2,
					borderColor: "#ffffff",
					borderRadius: 4,
					backgroundColor: active ? "#ffffff" : "transparent",
				}}
			/>
			{/* Bubble tail */}
			<View
				style={{
					position: "absolute",
					bottom: 0,
					left: ICON_SIZE * 0.15,
					width: 0,
					height: 0,
					borderTopWidth: 6,
					borderTopColor: active ? "#ffffff" : "transparent",
					borderRightWidth: 6,
					borderRightColor: "transparent",
					borderLeftWidth: 0,
					borderLeftColor: "transparent",
				}}
			/>
			{/* Tail border for outlined state */}
			{!active && (
				<View
					style={{
						position: "absolute",
						bottom: -1,
						left: ICON_SIZE * 0.15,
						width: 0,
						height: 0,
						borderTopWidth: 8,
						borderTopColor: "#ffffff",
						borderRightWidth: 8,
						borderRightColor: "transparent",
					}}
				/>
			)}
		</View>
	);
}

/**
 * Phone hangup icon - rotated phone
 */
function LeaveIcon() {
	const phoneWidth = ICON_SIZE * 0.7;
	const phoneHeight = ICON_SIZE * 0.25;

	return (
		<View style={[iconStyles.container, { transform: [{ rotate: "135deg" }] }]}>
			{/* Phone body */}
			<View
				style={{
					width: phoneWidth,
					height: phoneHeight,
					backgroundColor: "#ffffff",
					borderRadius: phoneHeight / 2,
					flexDirection: "row",
					justifyContent: "space-between",
					alignItems: "center",
					paddingHorizontal: 2,
				}}
			>
				{/* Left earpiece */}
				<View
					style={{
						width: phoneWidth * 0.25,
						height: phoneHeight * 1.6,
						backgroundColor: "#ffffff",
						borderRadius: 3,
					}}
				/>
				{/* Right earpiece */}
				<View
					style={{
						width: phoneWidth * 0.25,
						height: phoneHeight * 1.6,
						backgroundColor: "#ffffff",
						borderRadius: 3,
					}}
				/>
			</View>
		</View>
	);
}

export function ControlBar({
	onToggleAudio,
	onToggleVideo,
	onToggleScreenShare,
	onToggleChat,
	onLeave,
	isAudioEnabled = true,
	isVideoEnabled = true,
	isScreenSharing = false,
	isChatOpen = false,
	style,
}: ControlBarProps) {
	const buttonStyle = useMemo(
		() => ({
			width: BUTTON_SIZE,
			height: BUTTON_SIZE,
			borderRadius: BUTTON_SIZE / 2,
		}),
		[],
	);

	return (
		<View style={[styles.container, style]}>
			{/* Audio toggle */}
			<TouchableOpacity
				style={[
					styles.button,
					buttonStyle,
					!isAudioEnabled && styles.buttonInactive,
				]}
				onPress={onToggleAudio}
				activeOpacity={0.7}
			>
				<MicIcon active={isAudioEnabled} />
			</TouchableOpacity>

			{/* Video toggle */}
			<TouchableOpacity
				style={[
					styles.button,
					buttonStyle,
					!isVideoEnabled && styles.buttonInactive,
				]}
				onPress={onToggleVideo}
				activeOpacity={0.7}
			>
				<VideoIcon active={isVideoEnabled} />
			</TouchableOpacity>

			{/* Screen share toggle */}
			<TouchableOpacity
				style={[
					styles.button,
					buttonStyle,
					isScreenSharing && styles.buttonActive,
				]}
				onPress={onToggleScreenShare}
				activeOpacity={0.7}
			>
				<ScreenShareIcon active={isScreenSharing} />
			</TouchableOpacity>

			{/* Chat toggle */}
			<TouchableOpacity
				style={[styles.button, buttonStyle, isChatOpen && styles.buttonActive]}
				onPress={onToggleChat}
				activeOpacity={0.7}
			>
				<ChatIcon active={isChatOpen} />
			</TouchableOpacity>

			{/* Leave button */}
			<TouchableOpacity
				style={[styles.button, buttonStyle, styles.buttonLeave]}
				onPress={onLeave}
				activeOpacity={0.7}
			>
				<LeaveIcon />
			</TouchableOpacity>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: 12,
		paddingVertical: 12,
		paddingHorizontal: 16,
		backgroundColor: "rgba(0, 0, 0, 0.6)",
		borderRadius: 32,
	},
	button: {
		justifyContent: "center",
		alignItems: "center",
		backgroundColor: "#374151", // gray-700
	},
	buttonInactive: {
		backgroundColor: "#6b7280", // gray-500
	},
	buttonActive: {
		backgroundColor: "#3b82f6", // blue-500
	},
	buttonLeave: {
		backgroundColor: "#ef4444", // red-500
	},
});

const iconStyles = StyleSheet.create({
	container: {
		width: ICON_SIZE,
		height: ICON_SIZE,
		justifyContent: "center",
		alignItems: "center",
	},
	rowContainer: {
		width: ICON_SIZE,
		height: ICON_SIZE,
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
	},
	slash: {
		position: "absolute",
	},
});
