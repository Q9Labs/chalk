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
import { CHALK_THEME } from "../../theme";
import {
	MicrophoneIcon,
	VideoIcon,
	ScreenShareIcon as ScreenIcon,
	ChatIcon as ChatBubbleIcon,
	PhoneIcon,
} from "../../icons";

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

	const iconColor = CHALK_THEME.colors.text.primary;
	const activeIconColor = CHALK_THEME.colors.text.inverse;

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
				<MicrophoneIcon size={ICON_SIZE} color={iconColor} />
				{!isAudioEnabled && <View style={styles.slashOverlay} />}
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
				<VideoIcon size={ICON_SIZE} color={iconColor} />
				{!isVideoEnabled && <View style={styles.slashOverlay} />}
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
				<ScreenIcon
					size={ICON_SIZE}
					color={isScreenSharing ? activeIconColor : iconColor}
				/>
			</TouchableOpacity>

			{/* Chat toggle */}
			<TouchableOpacity
				style={[styles.button, buttonStyle, isChatOpen && styles.buttonActive]}
				onPress={onToggleChat}
				activeOpacity={0.7}
			>
				<ChatBubbleIcon
					size={ICON_SIZE}
					color={isChatOpen ? activeIconColor : iconColor}
				/>
			</TouchableOpacity>

			{/* Leave button */}
			<TouchableOpacity
				style={[styles.button, buttonStyle, styles.buttonLeave]}
				onPress={onLeave}
				activeOpacity={0.7}
			>
				<View style={styles.leaveIconRotate}>
					<PhoneIcon size={ICON_SIZE} color={iconColor} />
				</View>
			</TouchableOpacity>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: CHALK_THEME.spacing.md,
		paddingVertical: CHALK_THEME.spacing.sm,
		paddingHorizontal: CHALK_THEME.spacing.md,
		backgroundColor: CHALK_THEME.colors.ui.overlay,
		borderRadius: CHALK_THEME.borderRadius.full,
	},
	button: {
		justifyContent: "center",
		alignItems: "center",
		backgroundColor: CHALK_THEME.colors.ui.pillBg,
	},
	buttonInactive: {
		backgroundColor: "rgba(255, 255, 255, 0.05)",
	},
	buttonActive: {
		backgroundColor: CHALK_THEME.colors.primary,
	},
	buttonLeave: {
		backgroundColor: CHALK_THEME.colors.destructive,
	},
	slashOverlay: {
		position: "absolute",
		width: 2,
		height: ICON_SIZE * 1.2,
		backgroundColor: CHALK_THEME.colors.text.primary,
		transform: [{ rotate: "45deg" }],
	},
	leaveIconRotate: {
		transform: [{ rotate: "135deg" }],
	},
});
