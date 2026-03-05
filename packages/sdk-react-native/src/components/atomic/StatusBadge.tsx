/**
 * StatusBadge - Circular badge for muted/speaking/hand.raised states
 */

import { useMemo } from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { CHALK_THEME } from "../../theme";
import {
	MutedIcon as MuteIcon,
	SpeakingIcon as VolumeIcon,
	HandRaisedIcon as HandIcon,
} from "../../icons";

interface StatusBadgeProps {
	/** Badge type */
	type: "muted" | "speaking" | "hand.raised";
	/** Badge size in pixels (default: 24) */
	size?: number;
	/** Additional container styles */
	style?: ViewStyle;
}

const BADGE_COLORS = {
	muted: CHALK_THEME.colors.destructive,
	speaking: CHALK_THEME.colors.status.speaking,
	"hand.raised": CHALK_THEME.colors.status.warning,
} as const;

export function StatusBadge({ type, size = 24, style }: StatusBadgeProps) {
	const backgroundColor = BADGE_COLORS[type];
	const iconSize = size * 0.6;

	const containerStyle = useMemo(
		() => ({
			width: size,
			height: size,
			borderRadius: size / 2,
			backgroundColor,
		}),
		[size, backgroundColor],
	);

	return (
		<View style={[styles.container, containerStyle, style]}>
			{type === "muted" && (
				<MuteIcon size={iconSize} color={CHALK_THEME.colors.text.primary} />
			)}
			{type === "speaking" && (
				<VolumeIcon size={iconSize} color={CHALK_THEME.colors.text.primary} />
			)}
			{type === "hand.raised" && (
				<HandIcon size={iconSize} color={CHALK_THEME.colors.text.primary} />
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		justifyContent: "center",
		alignItems: "center",
		overflow: "hidden",
	},
});
