/**
 * Call Screen - Video conference screen
 * Reads roomId and create flag from search params
 * If create=true, creates room first then joins via VideoConference
 */

import { VideoConference, useChalk } from "@q9labs/chalk-react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export default function CallScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ roomId?: string; create?: string }>();
	const { createRoom } = useChalk();

	const [roomId, setRoomId] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const shouldCreate = params.create === "true";
	const initialRoomId = params.roomId;

	// Create room if needed, otherwise use provided roomId
	useEffect(() => {
		if (shouldCreate && initialRoomId) {
			setIsCreating(true);
			createRoom()
				.then((newRoomId) => {
					setRoomId(newRoomId);
					setIsCreating(false);
				})
				.catch((err) => {
					setError(err instanceof Error ? err.message : "Failed to create room");
					setIsCreating(false);
				});
		} else if (initialRoomId) {
			setRoomId(initialRoomId);
		} else {
			setError("No room ID provided");
		}
	}, [shouldCreate, initialRoomId, createRoom]);

	const handleLeave = useCallback(() => {
		router.back();
	}, [router]);

	// Loading state while creating room
	if (isCreating) {
		return (
			<View style={styles.container}>
				<ActivityIndicator size="large" color="#2563eb" />
				<Text style={styles.text}>Creating room...</Text>
			</View>
		);
	}

	// Error state
	if (error) {
		return (
			<View style={styles.container}>
				<Text style={styles.errorText}>{error}</Text>
			</View>
		);
	}

	// Waiting for roomId
	if (!roomId) {
		return (
			<View style={styles.container}>
				<ActivityIndicator size="large" color="#2563eb" />
			</View>
		);
	}

	return <VideoConference roomId={roomId} onLeave={handleLeave} />;
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#111827",
	},
	text: {
		color: "#f9fafb",
		fontSize: 16,
		marginTop: 16,
	},
	errorText: {
		color: "#fca5a5",
		fontSize: 16,
	},
});
