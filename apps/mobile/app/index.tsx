import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import {
	KeyboardAvoidingView,
	Platform,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";

function generateUUID() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function SettingsIcon({ onPress }: { onPress: () => void }) {
	return (
		<TouchableOpacity onPress={onPress} style={styles.settingsButton}>
			<View style={styles.gear}>
				<View style={styles.gearCenter} />
				{[0, 45, 90, 135].map((angle) => (
					<View
						key={angle}
						style={[
							styles.gearTooth,
							{ transform: [{ rotate: `${angle}deg` }] },
						]}
					/>
				))}
			</View>
		</TouchableOpacity>
	);
}

function ChalkLogo() {
	return (
		<View style={styles.logoContainer}>
			<View style={styles.logoIcon}>
				<View style={styles.chalkStick} />
				<View style={styles.chalkLine} />
			</View>
			<Text style={styles.logoText}>Chalk</Text>
			<Text style={styles.tagline}>Video conferencing for education</Text>
		</View>
	);
}

export default function Index() {
	const router = useRouter();
	const [showJoinInput, setShowJoinInput] = useState(false);
	const [roomId, setRoomId] = useState("");

	const handleStartMeeting = () => {
		const newRoomId = generateUUID();
		router.push(`/call?roomId=${newRoomId}&create=true`);
	};

	const handleJoinMeeting = () => {
		if (!showJoinInput) {
			setShowJoinInput(true);
			return;
		}
		if (roomId.trim()) {
			router.push(`/call?roomId=${roomId.trim()}`);
		}
	};

	const handleCancelJoin = () => {
		setShowJoinInput(false);
		setRoomId("");
	};

	return (
		<>
			<Stack.Screen
				options={{
					headerRight: () => (
						<SettingsIcon onPress={() => router.push("/settings")} />
					),
				}}
			/>
			<KeyboardAvoidingView
				style={styles.container}
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<ChalkLogo />

				<View style={styles.buttonContainer}>
					<TouchableOpacity
						style={styles.primaryButton}
						onPress={handleStartMeeting}
					>
						<Text style={styles.primaryButtonText}>Start Meeting</Text>
					</TouchableOpacity>

					{showJoinInput ? (
						<View style={styles.joinInputContainer}>
							<TextInput
								style={styles.input}
								placeholder="Enter Room ID"
								placeholderTextColor="#888"
								value={roomId}
								onChangeText={setRoomId}
								autoCapitalize="none"
								autoCorrect={false}
							/>
							<View style={styles.joinInputButtons}>
								<TouchableOpacity
									style={styles.cancelButton}
									onPress={handleCancelJoin}
								>
									<Text style={styles.cancelButtonText}>Cancel</Text>
								</TouchableOpacity>
								<TouchableOpacity
									style={[
										styles.joinButton,
										!roomId.trim() && styles.joinButtonDisabled,
									]}
									onPress={handleJoinMeeting}
									disabled={!roomId.trim()}
								>
									<Text style={styles.joinButtonText}>Join</Text>
								</TouchableOpacity>
							</View>
						</View>
					) : (
						<TouchableOpacity
							style={styles.secondaryButton}
							onPress={handleJoinMeeting}
						>
							<Text style={styles.secondaryButtonText}>Join Meeting</Text>
						</TouchableOpacity>
					)}
				</View>
			</KeyboardAvoidingView>
		</>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111",
		paddingHorizontal: 24,
	},
	settingsButton: {
		padding: 8,
		marginRight: 4,
	},
	gear: {
		width: 24,
		height: 24,
		justifyContent: "center",
		alignItems: "center",
	},
	gearCenter: {
		width: 10,
		height: 10,
		borderRadius: 5,
		borderWidth: 2,
		borderColor: "#fff",
	},
	gearTooth: {
		position: "absolute",
		width: 4,
		height: 24,
		backgroundColor: "#fff",
		borderRadius: 2,
	},
	logoContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	logoIcon: {
		width: 80,
		height: 80,
		marginBottom: 16,
		justifyContent: "center",
		alignItems: "center",
	},
	chalkStick: {
		width: 12,
		height: 60,
		backgroundColor: "#fff",
		borderRadius: 4,
		transform: [{ rotate: "-30deg" }],
	},
	chalkLine: {
		position: "absolute",
		bottom: 8,
		width: 40,
		height: 4,
		backgroundColor: "#4a90d9",
		borderRadius: 2,
		transform: [{ rotate: "-30deg" }],
	},
	logoText: {
		fontSize: 48,
		fontWeight: "bold",
		color: "#fff",
		marginBottom: 8,
	},
	tagline: {
		fontSize: 16,
		color: "#888",
	},
	buttonContainer: {
		paddingBottom: 48,
		gap: 16,
	},
	primaryButton: {
		backgroundColor: "#4a90d9",
		paddingVertical: 16,
		borderRadius: 12,
		alignItems: "center",
	},
	primaryButtonText: {
		color: "#fff",
		fontSize: 18,
		fontWeight: "600",
	},
	secondaryButton: {
		backgroundColor: "transparent",
		paddingVertical: 16,
		borderRadius: 12,
		alignItems: "center",
		borderWidth: 2,
		borderColor: "#4a90d9",
	},
	secondaryButtonText: {
		color: "#4a90d9",
		fontSize: 18,
		fontWeight: "600",
	},
	joinInputContainer: {
		gap: 12,
	},
	input: {
		backgroundColor: "#222",
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 14,
		color: "#fff",
		fontSize: 16,
		borderWidth: 1,
		borderColor: "#333",
	},
	joinInputButtons: {
		flexDirection: "row",
		gap: 12,
	},
	cancelButton: {
		flex: 1,
		backgroundColor: "transparent",
		paddingVertical: 14,
		borderRadius: 12,
		alignItems: "center",
		borderWidth: 2,
		borderColor: "#444",
	},
	cancelButtonText: {
		color: "#888",
		fontSize: 16,
		fontWeight: "600",
	},
	joinButton: {
		flex: 1,
		backgroundColor: "#4a90d9",
		paddingVertical: 14,
		borderRadius: 12,
		alignItems: "center",
	},
	joinButtonDisabled: {
		backgroundColor: "#2a4a6a",
	},
	joinButtonText: {
		color: "#fff",
		fontSize: 16,
		fontWeight: "600",
	},
});
