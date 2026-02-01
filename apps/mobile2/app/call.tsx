/**
 * Call Screen - Uses VideoConference from SDK
 */

import { VideoConference } from "@q9labs/chalk-react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { StyleSheet } from "react-native";
import { env } from "@/lib/env";

export default function CallScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ roomId?: string; create?: string }>();

	const roomId = params.roomId ?? undefined;

	const handleLeave = useCallback(() => {
		router.back();
	}, [router]);

	// Render VideoConference
	return (
		<VideoConference
			roomId={roomId}
			onLeave={handleLeave}
			apiKey={env.apiKey}
			apiUrl={env.apiUrl}
			wsUrl={env.wsUrl}
			style={styles.container}
		/>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111827",
	},
});
