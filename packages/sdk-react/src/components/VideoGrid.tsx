/**
 * VideoGrid component - Displays participants in an auto-layout grid
 */

import type { Participant } from "@q9labs/chalk-core";
import React, { type CSSProperties, useMemo } from "react";
import { VideoTile, type VideoTileProps } from "./VideoTile.tsx";

export interface VideoGridProps {
	/** Array of participants to display */
	participants: Participant[];
	/** Additional CSS class names */
	className?: string;
	/** Inline styles */
	style?: CSSProperties;
	/** Maximum number of participants per row */
	maxColumns?: number;
	/** Gap between tiles in pixels */
	gap?: number;
	/** Aspect ratio for tiles (width / height) */
	aspectRatio?: number;
	/** Layout mode: 'grid' for equal sizes, 'spotlight' for one large + others small */
	layout?: "grid" | "spotlight";
	/** ID of participant to spotlight (used when layout='spotlight') */
	spotlightId?: string;
	/** Props to pass to each VideoTile */
	tileProps?: Omit<VideoTileProps, "participant">;
	/** Custom render function for each tile */
	renderTile?: (participant: Participant, index: number) => React.ReactNode;
}

/**
 * VideoGrid - Displays participants in an auto-sizing grid layout
 *
 * @example
 * ```tsx
 * // Basic grid
 * <VideoGrid participants={participants} />
 *
 * // Spotlight layout with active speaker
 * <VideoGrid
 *   participants={participants}
 *   layout="spotlight"
 *   spotlightId={activeSpeaker?.id}
 * />
 *
 * // Custom tile rendering
 * <VideoGrid
 *   participants={participants}
 *   renderTile={(p) => <CustomVideoTile participant={p} />}
 * />
 * ```
 */
export function VideoGrid({
	participants,
	className,
	style,
	maxColumns = 4,
	gap = 8,
	aspectRatio = 16 / 9,
	layout = "grid",
	spotlightId,
	tileProps,
	renderTile,
}: VideoGridProps) {
	// Calculate optimal grid layout
	const { columns, rows } = useMemo(() => {
		const count = participants.length;
		if (count === 0) return { columns: 0, rows: 0 };
		if (count === 1) return { columns: 1, rows: 1 };
		if (count === 2) return { columns: 2, rows: 1 };

		// Find optimal grid size
		const cols = Math.min(Math.ceil(Math.sqrt(count)), maxColumns);
		const rowsNeeded = Math.ceil(count / cols);

		return { columns: cols, rows: rowsNeeded };
	}, [participants.length, maxColumns]);

	const containerStyle: CSSProperties = {
		display: "grid",
		gap: `${gap}px`,
		width: "100%",
		height: "100%",
		padding: `${gap}px`,
		boxSizing: "border-box",
		...style,
	};

	// Standard grid layout
	if (layout === "grid") {
		const gridStyle: CSSProperties = {
			...containerStyle,
			gridTemplateColumns: `repeat(${columns}, 1fr)`,
			gridTemplateRows: `repeat(${rows}, 1fr)`,
		};

		return (
			<div className={`chalk-video-grid ${className ?? ""}`} style={gridStyle}>
				{participants.map((participant, index) =>
					renderTile ? (
						<React.Fragment key={participant.id}>
							{renderTile(participant, index)}
						</React.Fragment>
					) : (
						<VideoTile
							key={participant.id}
							participant={participant}
							mirror={participant.isLocal}
							{...tileProps}
						/>
					),
				)}
			</div>
		);
	}

	// Spotlight layout - one large video, rest in sidebar
	const spotlightParticipant = spotlightId
		? participants.find((p) => p.id === spotlightId)
		: participants[0];

	const sidebarParticipants = participants.filter(
		(p) => p.id !== spotlightParticipant?.id,
	);

	const spotlightContainerStyle: CSSProperties = {
		...containerStyle,
		display: "flex",
		flexDirection: "row",
	};

	const mainStyle: CSSProperties = {
		flex: 1,
		minWidth: 0,
	};

	const sidebarStyle: CSSProperties = {
		width: sidebarParticipants.length > 0 ? "200px" : "0",
		display: "flex",
		flexDirection: "column",
		gap: `${gap}px`,
		marginLeft: sidebarParticipants.length > 0 ? `${gap}px` : "0",
		overflowY: "auto",
	};

	const sidebarTileStyle: CSSProperties = {
		aspectRatio: String(aspectRatio),
		flexShrink: 0,
	};

	return (
		<div
			className={`chalk-video-grid chalk-video-grid--spotlight ${className ?? ""}`}
			style={spotlightContainerStyle}
		>
			{/* Main spotlight video */}
			<div style={mainStyle}>
				{spotlightParticipant &&
					(renderTile ? (
						renderTile(spotlightParticipant, 0)
					) : (
						<VideoTile
							participant={spotlightParticipant}
							mirror={spotlightParticipant.isLocal}
							{...tileProps}
						/>
					))}
			</div>

			{/* Sidebar with other participants */}
			{sidebarParticipants.length > 0 && (
				<div style={sidebarStyle}>
					{sidebarParticipants.map((participant, index) =>
						renderTile ? (
							<div key={participant.id} style={sidebarTileStyle}>
								{renderTile(participant, index + 1)}
							</div>
						) : (
							<div key={participant.id} style={sidebarTileStyle}>
								<VideoTile
									participant={participant}
									mirror={participant.isLocal}
									{...tileProps}
								/>
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}
