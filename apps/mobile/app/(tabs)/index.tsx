import { useChalk } from "@q9labs/chalk-react-native";
import { router } from "expo-router";
import {
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBadge } from "@/components/test/TestScreen";

const HOOKS = [
	{
		id: "room",
		name: "useRoom",
		description: "Join/leave, status transitions",
	},
	{ id: "media", name: "useMedia", description: "Toggle video/audio" },
	{
		id: "participants",
		name: "useParticipants",
		description: "Local/remote lists",
	},
	{ id: "devices", name: "useDevices", description: "Enumerate cameras/mics" },
	{
		id: "permissions",
		name: "usePermissions",
		description: "Request/check permissions",
	},
	{ id: "chat", name: "useChat", description: "Send/receive messages" },
	{
		id: "recording",
		name: "useRecording",
		description: "Start/stop recording",
	},
	{ id: "screen-share", name: "useScreenShare", description: "Share screen" },
	{
		id: "audio-routing",
		name: "useAudioRouting",
		description: "Speaker/earpiece/bluetooth",
	},
	{ id: "call-kit", name: "useCallKit", description: "iOS call integration" },
	{
		id: "foreground-service",
		name: "useForegroundService",
		description: "Android background service",
	},
	{ id: "interactions", name: "useInteractions", description: "Reactions" },
	{ id: "hand-raise", name: "useHandRaise", description: "Raise/lower hand" },
	{ id: "local-stream", name: "useLocalStream", description: "Camera preview" },
];

const COMPONENTS = [
	{ id: "video-view", name: "VideoView", description: "Single video stream" },
	{
		id: "screen-share-view",
		name: "ScreenShareView",
		description: "Screen share display",
	},
	{
		id: "participant-tile",
		name: "ParticipantTile",
		description: "Participant avatar/video",
	},
	{ id: "video-grid", name: "VideoGrid", description: "Grid of participants" },
	{
		id: "audio-session",
		name: "AudioSession",
		description: "Audio session wrapper",
	},
];

const E2E_FLOWS = [
	{
		id: "pre-call",
		name: "Pre-call Flow",
		description: "Permissions, device selection, preview",
	},
	{
		id: "full-call",
		name: "Full Call Flow",
		description: "Join, interact, leave",
	},
];

export default function Dashboard() {
	const { connectionStatus, isConnected } = useChalk();

	return (
		<SafeAreaView style={styles.container} edges={["top"]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<View style={styles.header}>
					<Text style={styles.title}>Chalk SDK Test</Text>
					<Text style={styles.subtitle}>React Native</Text>
				</View>

				<View style={styles.statusSection}>
					<StatusBadge
						label="Connection"
						value={connectionStatus}
						color={isConnected ? "green" : "gray"}
					/>
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Hooks ({HOOKS.length})</Text>
					<View style={styles.grid}>
						{HOOKS.map((hook) => (
							<TouchableOpacity
								key={hook.id}
								style={styles.card}
								onPress={() => router.push(`/hooks/${hook.id}`)}
							>
								<Text style={styles.cardTitle}>{hook.name}</Text>
								<Text style={styles.cardDescription}>{hook.description}</Text>
							</TouchableOpacity>
						))}
					</View>
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>
						Components ({COMPONENTS.length})
					</Text>
					<View style={styles.grid}>
						{COMPONENTS.map((component) => (
							<TouchableOpacity
								key={component.id}
								style={styles.card}
								onPress={() => router.push(`/components/${component.id}`)}
							>
								<Text style={styles.cardTitle}>{component.name}</Text>
								<Text style={styles.cardDescription}>
									{component.description}
								</Text>
							</TouchableOpacity>
						))}
					</View>
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>
						E2E Flows ({E2E_FLOWS.length})
					</Text>
					<View style={styles.grid}>
						{E2E_FLOWS.map((flow) => (
							<TouchableOpacity
								key={flow.id}
								style={[styles.card, styles.cardWide]}
								onPress={() => router.push(`/e2e/${flow.id}`)}
							>
								<Text style={styles.cardTitle}>{flow.name}</Text>
								<Text style={styles.cardDescription}>{flow.description}</Text>
							</TouchableOpacity>
						))}
					</View>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#f5f5f5",
	},
	scroll: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	header: {
		marginBottom: 24,
	},
	title: {
		fontSize: 34,
		fontWeight: "700",
		color: "#1a1a1a",
	},
	subtitle: {
		fontSize: 17,
		color: "#666",
		marginTop: 4,
	},
	statusSection: {
		backgroundColor: "#fff",
		borderRadius: 12,
		padding: 16,
		marginBottom: 24,
	},
	section: {
		marginBottom: 24,
	},
	sectionTitle: {
		fontSize: 20,
		fontWeight: "600",
		color: "#1a1a1a",
		marginBottom: 12,
	},
	grid: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 12,
	},
	card: {
		backgroundColor: "#fff",
		borderRadius: 12,
		padding: 16,
		width: "48%",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 1 },
		shadowOpacity: 0.05,
		shadowRadius: 2,
		elevation: 1,
	},
	cardWide: {
		width: "100%",
	},
	cardTitle: {
		fontSize: 16,
		fontWeight: "600",
		color: "#1a1a1a",
		marginBottom: 4,
	},
	cardDescription: {
		fontSize: 13,
		color: "#666",
	},
});
