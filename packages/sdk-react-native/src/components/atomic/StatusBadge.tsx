/**
 * StatusBadge - Circular badge for muted/speaking/hand-raised states
 */

import { useMemo } from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";

interface StatusBadgeProps {
	/** Badge type */
	type: "muted" | "speaking" | "hand-raised";
	/** Badge size in pixels (default: 24) */
	size?: number;
	/** Additional container styles */
	style?: ViewStyle;
}

const BADGE_COLORS = {
	muted: "#ef4444", // red
	speaking: "#22c55e", // green
	"hand-raised": "#eab308", // yellow
} as const;

/**
 * Muted icon - mic shape with slash
 */
function MutedIcon({ size }: { size: number }) {
	const micWidth = size * 0.3;
	const micHeight = size * 0.45;
	const slashWidth = size * 0.08;

	return (
		<View style={styles.iconContainer}>
			{/* Mic body */}
			<View
				style={{
					width: micWidth,
					height: micHeight,
					backgroundColor: "#ffffff",
					borderRadius: micWidth / 2,
				}}
			/>
			{/* Mic stand */}
			<View
				style={{
					width: slashWidth,
					height: size * 0.15,
					backgroundColor: "#ffffff",
					marginTop: 1,
				}}
			/>
			{/* Diagonal slash */}
			<View
				style={[
					styles.slash,
					{
						width: slashWidth,
						height: size * 0.7,
						backgroundColor: "#ef4444",
						transform: [{ rotate: "45deg" }],
					},
				]}
			/>
		</View>
	);
}

/**
 * Speaking icon - 3 waveform bars
 */
function SpeakingIcon({ size }: { size: number }) {
	const barWidth = size * 0.08;
	const gap = size * 0.06;

	return (
		<View style={[styles.barsContainer, { gap }]}>
			<View
				style={[
					styles.bar,
					{ width: barWidth, height: size * 0.25, backgroundColor: "#ffffff" },
				]}
			/>
			<View
				style={[
					styles.bar,
					{ width: barWidth, height: size * 0.45, backgroundColor: "#ffffff" },
				]}
			/>
			<View
				style={[
					styles.bar,
					{ width: barWidth, height: size * 0.35, backgroundColor: "#ffffff" },
				]}
			/>
		</View>
	);
}

/**
 * Hand raised icon - simplified hand shape
 */
function HandRaisedIcon({ size }: { size: number }) {
	const fingerWidth = size * 0.1;
	const fingerHeight = size * 0.28;
	const palmSize = size * 0.35;
	const gap = size * 0.03;

	return (
		<View style={styles.handContainer}>
			{/* Fingers */}
			<View style={[styles.fingersRow, { gap }]}>
				{[0.85, 1, 0.9, 0.75].map((scale, i) => (
					<View
						key={i}
						style={[
							styles.finger,
							{
								width: fingerWidth,
								height: fingerHeight * scale,
								backgroundColor: "#ffffff",
								borderRadius: fingerWidth / 2,
							},
						]}
					/>
				))}
			</View>
			{/* Palm */}
			<View
				style={{
					width: palmSize,
					height: size * 0.2,
					backgroundColor: "#ffffff",
					borderRadius: size * 0.05,
					marginTop: -size * 0.02,
				}}
			/>
		</View>
	);
}

export function StatusBadge({ type, size = 24, style }: StatusBadgeProps) {
	const backgroundColor = BADGE_COLORS[type];

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
			{type === "muted" && <MutedIcon size={size} />}
			{type === "speaking" && <SpeakingIcon size={size} />}
			{type === "hand-raised" && <HandRaisedIcon size={size} />}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		justifyContent: "center",
		alignItems: "center",
		overflow: "hidden",
	},
	iconContainer: {
		alignItems: "center",
		justifyContent: "center",
	},
	slash: {
		position: "absolute",
	},
	barsContainer: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
	},
	bar: {
		borderRadius: 2,
	},
	handContainer: {
		alignItems: "center",
		justifyContent: "flex-end",
	},
	fingersRow: {
		flexDirection: "row",
		alignItems: "flex-end",
	},
	finger: {
		// Base finger style
	},
});
