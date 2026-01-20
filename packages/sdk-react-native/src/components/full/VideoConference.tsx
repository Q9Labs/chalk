/**
 * VideoConference - Turnkey orchestrator component
 * State machine: lobby → joining → connected → ended
 * Combines PreJoinLobby and MeetingRoom into single entry point
 */

import { useCallback, useState } from "react";
import {
	ActivityIndicator,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import { useChalk } from "../../ChalkProvider";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";

type ConferenceState = "lobby" | "joining" | "connected" | "error" | "ended";

interface VideoConferenceProps {
	/** Room ID to join */
	roomId: string;
	/** Optional initial display name */
	displayName?: string;
	/** Callback when user leaves or ends the conference */
	onLeave: () => void;
	/** Additional container styles */
	style?: ViewStyle;
}

export function VideoConference({
	roomId,
	displayName,
	onLeave,
	style,
}: VideoConferenceProps) {
	const { joinRoom } = useChalk();
	const [state, setState] = useState<ConferenceState>("lobby");
	const [error, setError] = useState<string | null>(null);

	const handleJoin = useCallback(
		async (name: string) => {
			setState("joining");
			setError(null);

			try {
				await joinRoom(roomId, {
					displayName: name,
					audio: true,
					video: true,
				});
				setState("connected");
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to join room";
				setError(message);
				setState("error");
			}
		},
		[joinRoom, roomId],
	);

	const handleLeave = useCallback(() => {
		setState("ended");
		onLeave();
	}, [onLeave]);

	const handleRetry = useCallback(() => {
		setError(null);
		setState("lobby");
	}, []);

	// Lobby state - show PreJoinLobby
	if (state === "lobby") {
		return (
			<PreJoinLobby
				roomId={roomId}
				initialName={displayName}
				onJoin={handleJoin}
				style={style}
			/>
		);
	}

	// Joining state - show loading indicator
	if (state === "joining") {
		return (
			<View style={[styles.container, styles.centerContent, style]}>
				<ActivityIndicator size="large" color="#2563eb" />
				<Text style={styles.statusText}>Joining room...</Text>
				<Text style={styles.statusSubtext}>{roomId}</Text>
			</View>
		);
	}

	// Error state - show error with retry
	if (state === "error") {
		return (
			<View style={[styles.container, styles.centerContent, style]}>
				<View style={styles.errorIcon}>
					<Text style={styles.errorIconText}>!</Text>
				</View>
				<Text style={styles.errorTitle}>Unable to join</Text>
				<Text style={styles.errorMessage}>{error}</Text>
				<View style={styles.errorActions}>
					<TouchableOpacity
						style={styles.retryButton}
						onPress={handleRetry}
						activeOpacity={0.8}
					>
						<Text style={styles.retryButtonText}>Try Again</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={styles.cancelButton}
						onPress={onLeave}
						activeOpacity={0.8}
					>
						<Text style={styles.cancelButtonText}>Cancel</Text>
					</TouchableOpacity>
				</View>
			</View>
		);
	}

	// Connected state - show MeetingRoom
	if (state === "connected") {
		return <MeetingRoom onLeave={handleLeave} style={style} />;
	}

	// Ended state - component should unmount via onLeave, but render nothing as fallback
	return null;
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111827", // gray-900
	},
	centerContent: {
		justifyContent: "center",
		alignItems: "center",
		paddingHorizontal: 32,
	},
	statusText: {
		marginTop: 24,
		fontSize: 18,
		fontWeight: "600",
		color: "#f9fafb", // gray-50
	},
	statusSubtext: {
		marginTop: 8,
		fontSize: 14,
		color: "#9ca3af", // gray-400
	},
	errorIcon: {
		width: 64,
		height: 64,
		borderRadius: 32,
		backgroundColor: "#7f1d1d", // red-900
		justifyContent: "center",
		alignItems: "center",
		marginBottom: 16,
	},
	errorIconText: {
		fontSize: 32,
		fontWeight: "700",
		color: "#fca5a5", // red-300
	},
	errorTitle: {
		fontSize: 20,
		fontWeight: "600",
		color: "#f9fafb", // gray-50
		marginBottom: 8,
	},
	errorMessage: {
		fontSize: 14,
		color: "#9ca3af", // gray-400
		textAlign: "center",
		marginBottom: 32,
	},
	errorActions: {
		flexDirection: "row",
		gap: 12,
	},
	retryButton: {
		backgroundColor: "#2563eb", // blue-600
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: 8,
	},
	retryButtonText: {
		fontSize: 16,
		fontWeight: "600",
		color: "#ffffff",
	},
	cancelButton: {
		backgroundColor: "#374151", // gray-700
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: 8,
	},
	cancelButtonText: {
		fontSize: 16,
		fontWeight: "500",
		color: "#d1d5db", // gray-300
	},
});
