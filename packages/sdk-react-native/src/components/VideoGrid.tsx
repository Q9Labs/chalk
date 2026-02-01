/**
 * VideoGrid - Responsive grid layout for participant video tiles
 * Automatically adjusts columns based on participant count
 */

import { useMemo } from "react";
import { View, StyleSheet, useWindowDimensions, type ViewStyle } from "react-native";
import type { Participant } from "@q9labs/chalk-core";
import { CHALK_THEME } from "../theme";
import { ParticipantTile } from "./ParticipantTile";

interface VideoGridProps {
	/** Array of participants to display */
	participants: Participant[];
	/** Container style */
	style?: ViewStyle;
	/** Gap between tiles in pixels (default: CHALK_THEME.spacing.sm) */
	gap?: number;
}

/**
 * Calculate optimal grid layout based on participant count and screen dimensions
 */
function getGridLayout(count: number, screenWidth: number, screenHeight: number) {
	const isLandscape = screenWidth > screenHeight;

	if (count <= 1) return { cols: 1, rows: 1 };
	if (count === 2) return isLandscape ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
	if (count <= 4) return { cols: 2, rows: 2 };
	if (count <= 6) return isLandscape ? { cols: 3, rows: 2 } : { cols: 2, rows: 3 };
	if (count <= 9) return { cols: 3, rows: 3 };
	return { cols: 4, rows: Math.ceil(count / 4) };
}

export function VideoGrid({ participants, style, gap = CHALK_THEME.spacing.sm }: VideoGridProps) {
	const { width, height } = useWindowDimensions();

	const layout = useMemo(
		() => getGridLayout(participants.length, width, height),
		[participants.length, width, height],
	);

	// Calculate tile dimensions
	const availableWidth = width - gap * (layout.cols + 1);
	const availableHeight = height - gap * (layout.rows + 1) - 200; // Account for header/controls
	const tileWidth = availableWidth / layout.cols;
	const tileHeight = Math.min(availableHeight / layout.rows, tileWidth * 0.75); // 4:3 aspect

	// Chunk participants into rows
	const rows = useMemo(() => {
		const result: Participant[][] = [];
		for (let i = 0; i < participants.length; i += layout.cols) {
			result.push(participants.slice(i, i + layout.cols));
		}
		return result;
	}, [participants, layout.cols]);

	return (
		<View style={[styles.container, style]}>
			{rows.map((row, rowIndex) => (
				<View
					key={`row-${rowIndex}`}
					style={[styles.row, { gap, marginBottom: rowIndex < rows.length - 1 ? gap : 0 }]}
				>
					{row.map((participant) => (
						<ParticipantTile
							key={participant.id}
							participant={participant}
							style={{ width: tileWidth, height: tileHeight }}
						/>
					))}
					{/* Fill empty slots in last row */}
					{row.length < layout.cols &&
						Array.from({ length: layout.cols - row.length }).map((_, i) => (
							<View
								key={`empty-${i}`}
								style={{ width: tileWidth, height: tileHeight }}
							/>
						))}
				</View>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	row: {
		flexDirection: "row",
		justifyContent: "center",
	},
});
