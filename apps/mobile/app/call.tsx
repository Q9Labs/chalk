/**
 * Call Screen - Uses VideoConference from SDK
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

// Lazy load SDK components to catch any import errors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let VideoConferenceComponent: React.ComponentType<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useChalkHook: (() => any) | null = null;

try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const sdk = require("@q9labs/chalk-react-native");
	VideoConferenceComponent = sdk.VideoConference;
	useChalkHook = sdk.useChalk;
} catch (err) {
	console.error("Failed to load SDK components:", err);
}

export default function CallScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ roomId?: string; create?: string }>();
	const [roomId, setRoomId] = useState<string | null>(params.roomId ?? null);
	const [error, setError] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);

	// Get createRoom from SDK if available
	const chalkContext = useChalkHook?.();

	// Create room if needed
	useEffect(() => {
		const shouldCreate = params.create === "true" && !roomId;
		if (shouldCreate && chalkContext?.createRoom && !isCreating) {
			setIsCreating(true);
			chalkContext
				.createRoom()
				.then((newRoomId: string) => {
					setRoomId(newRoomId);
					setIsCreating(false);
				})
				.catch((err: Error) => {
					setError(err.message);
					setIsCreating(false);
				});
		}
	}, [params.create, roomId, chalkContext, isCreating]);

	const handleLeave = useCallback(() => {
		router.back();
	}, [router]);

	// SDK not available
	if (!VideoConferenceComponent || !useChalkHook) {
		return (
			<View style={[styles.container, styles.center]}>
				<Text style={styles.errorText}>SDK components not available</Text>
				<TouchableOpacity style={styles.button} onPress={handleLeave}>
					<Text style={styles.buttonText}>Go Back</Text>
				</TouchableOpacity>
			</View>
		);
	}

	// Creating room
	if (isCreating) {
		return (
			<View style={[styles.container, styles.center]}>
				<ActivityIndicator size="large" color="#2563eb" />
				<Text style={styles.loadingText}>Creating room...</Text>
			</View>
		);
	}

	// Error state
	if (error) {
		return (
			<View style={[styles.container, styles.center]}>
				<Text style={styles.errorText}>{error}</Text>
				<TouchableOpacity style={styles.button} onPress={handleLeave}>
					<Text style={styles.buttonText}>Go Back</Text>
				</TouchableOpacity>
			</View>
		);
	}

	// No room ID
	if (!roomId) {
		return (
			<View style={[styles.container, styles.center]}>
				<Text style={styles.errorText}>No room ID provided</Text>
				<TouchableOpacity style={styles.button} onPress={handleLeave}>
					<Text style={styles.buttonText}>Go Back</Text>
				</TouchableOpacity>
			</View>
		);
	}

	// Render VideoConference
	return (
		<VideoConferenceComponent
			roomId={roomId}
			onLeave={handleLeave}
			style={styles.container}
		/>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111827",
	},
	center: {
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
	},
	loadingText: {
		marginTop: 16,
		color: "#fff",
		fontSize: 16,
	},
	errorText: {
		color: "#ef4444",
		fontSize: 16,
		textAlign: "center",
		marginBottom: 24,
	},
	button: {
		backgroundColor: "#374151",
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: 8,
	},
	buttonText: {
		color: "#fff",
		fontSize: 16,
		fontWeight: "600",
	},
});
