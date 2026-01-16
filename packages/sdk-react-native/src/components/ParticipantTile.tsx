/**
 * ParticipantTile - Renders a participant's video or avatar
 * For use in video grids showing remote participants
 */

import { useMemo } from "react";
import { View, Text, StyleSheet, type ViewStyle } from "react-native";
import type { Participant } from "@q9labs/chalk-core";
import { VideoView } from "./VideoView";

interface ParticipantTileProps {
	/** Participant data including video/audio tracks */
	participant: Participant;
	/** Mirror video (for local camera) */
	mirror?: boolean;
	/** Show name label */
	showName?: boolean;
	/** Container style */
	style?: ViewStyle;
}

// Dynamic require for MediaStream constructor (not available as type-only import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MediaStreamClass: { new (tracks?: unknown[]): any } | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	MediaStreamClass = require("@cloudflare/react-native-webrtc").MediaStream;
} catch {
	// Native module not available
}

/**
 * Creates a MediaStream from a track for rendering
 */
function createStreamFromTrack(track: unknown): MediaStream | null {
	if (!track || !MediaStreamClass) return null;
	try {
		// In react-native-webrtc, we need to create a MediaStream from the track
		const stream = new MediaStreamClass();
		stream.addTrack(track);
		return stream as MediaStream;
	} catch {
		return null;
	}
}

export function ParticipantTile({
	participant,
	mirror = false,
	showName = true,
	style,
}: ParticipantTileProps) {
	const { displayName, videoEnabled, videoTrack, audioEnabled, isLocal } = participant;

	// Create stream from video track
	const videoStream = useMemo(
		() => (videoEnabled ? createStreamFromTrack(videoTrack) : null),
		[videoEnabled, videoTrack],
	);

	const initials = displayName
		.split(" ")
		.map((n) => n[0])
		.join("")
		.toUpperCase()
		.slice(0, 2);

	return (
		<View style={[styles.container, style]}>
			{videoStream ? (
				<VideoView
					stream={videoStream}
					mirror={mirror || isLocal}
					objectFit="cover"
					style={styles.video}
				/>
			) : (
				<View style={styles.avatarContainer}>
					<View style={styles.avatar}>
						<Text style={styles.avatarText}>{initials}</Text>
					</View>
				</View>
			)}

			{/* Mute indicator */}
			{!audioEnabled && (
				<View style={styles.muteIndicator}>
					<Text style={styles.muteIcon}>🔇</Text>
				</View>
			)}

			{/* Name label */}
			{showName && (
				<View style={styles.nameContainer}>
					<Text style={styles.nameText} numberOfLines={1}>
						{displayName}
						{isLocal && " (You)"}
					</Text>
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		borderRadius: 12,
		overflow: "hidden",
		backgroundColor: "#1a1a1a",
		position: "relative",
	},
	video: {
		flex: 1,
		backgroundColor: "#000",
	},
	avatarContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		backgroundColor: "#2a2a2a",
	},
	avatar: {
		width: 64,
		height: 64,
		borderRadius: 32,
		backgroundColor: "rgba(255,255,255,0.1)",
		justifyContent: "center",
		alignItems: "center",
	},
	avatarText: {
		color: "#fff",
		fontSize: 24,
		fontWeight: "600",
	},
	muteIndicator: {
		position: "absolute",
		top: 8,
		right: 8,
		backgroundColor: "rgba(0,0,0,0.6)",
		borderRadius: 12,
		padding: 4,
	},
	muteIcon: {
		fontSize: 12,
	},
	nameContainer: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		backgroundColor: "rgba(0,0,0,0.6)",
		paddingHorizontal: 8,
		paddingVertical: 4,
	},
	nameText: {
		color: "#fff",
		fontSize: 12,
		fontWeight: "500",
	},
});
