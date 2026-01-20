/**
 * PreJoinLobby - Turnkey component for pre-call setup
 * Camera preview, device selection, name input, and join button
 */

import { useCallback, useEffect, useState } from "react";
import {
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import { useDevices } from "../../hooks/useDevices";
import { useLocalStream } from "../../hooks/useLocalStream";
import { usePermissions } from "../../hooks/usePermissions";
import { Avatar } from "../atomic/Avatar";
import { DeviceSelector } from "../composite/DeviceSelector";
import { VideoView } from "../VideoView";

interface PreJoinLobbyProps {
	/** Callback when user taps join with their display name */
	onJoin: (displayName: string) => void;
	/** Optional room ID to display */
	roomId?: string;
	/** Initial display name */
	initialName?: string;
	/** Additional container styles */
	style?: ViewStyle;
}

/** Camera icon drawn with View components */
function CameraIcon({ color }: { color: string }) {
	return (
		<View style={iconStyles.cameraContainer}>
			<View style={[iconStyles.cameraBody, { borderColor: color }]} />
			<View style={[iconStyles.cameraLens, { borderColor: color }]} />
		</View>
	);
}

/** Microphone icon drawn with View components */
function MicIcon({ color }: { color: string }) {
	return (
		<View style={iconStyles.micContainer}>
			<View style={[iconStyles.micHead, { borderColor: color }]} />
			<View style={[iconStyles.micStand, { backgroundColor: color }]} />
			<View style={[iconStyles.micBase, { backgroundColor: color }]} />
		</View>
	);
}

export function PreJoinLobby({
	onJoin,
	roomId,
	initialName = "",
	style,
}: PreJoinLobbyProps) {
	const [displayName, setDisplayName] = useState(initialName);
	const [showCameraSelector, setShowCameraSelector] = useState(false);
	const [showMicSelector, setShowMicSelector] = useState(false);

	const { hasRequiredPermissions, requestPermissions, isChecking } =
		usePermissions();
	const { cameras, microphones, selectedCamera, selectedMicrophone, selectCamera, selectMicrophone } =
		useDevices();
	const { stream, startStream, isLoading: isStreamLoading } = useLocalStream();

	// Request permissions on mount
	useEffect(() => {
		if (!isChecking && !hasRequiredPermissions) {
			requestPermissions();
		}
	}, [isChecking, hasRequiredPermissions, requestPermissions]);

	// Start local stream when permissions are granted
	useEffect(() => {
		if (hasRequiredPermissions && !stream && !isStreamLoading) {
			startStream();
		}
	}, [hasRequiredPermissions, stream, isStreamLoading, startStream]);

	const handleJoin = useCallback(() => {
		const trimmed = displayName.trim();
		if (trimmed && hasRequiredPermissions) {
			onJoin(trimmed);
		}
	}, [displayName, hasRequiredPermissions, onJoin]);

	const handleCameraSelect = useCallback(
		(deviceId: string) => {
			selectCamera(deviceId);
		},
		[selectCamera],
	);

	const handleMicSelect = useCallback(
		(deviceId: string) => {
			selectMicrophone(deviceId);
		},
		[selectMicrophone],
	);

	const canJoin = displayName.trim().length > 0 && hasRequiredPermissions;

	return (
		<View style={[styles.container, style]}>
			{/* Room ID header */}
			{roomId && (
				<View style={styles.header}>
					<Text style={styles.roomLabel}>Room</Text>
					<Text style={styles.roomId} numberOfLines={1}>
						{roomId}
					</Text>
				</View>
			)}

			{/* Video preview */}
			<View style={styles.previewContainer}>
				{stream ? (
					<VideoView stream={stream} mirror style={styles.videoPreview} />
				) : (
					<View style={styles.avatarContainer}>
						<Avatar name={displayName || "You"} size={100} />
						{!hasRequiredPermissions && (
							<Text style={styles.permissionHint}>
								Camera access required
							</Text>
						)}
					</View>
				)}
			</View>

			{/* Device selector buttons */}
			<View style={styles.deviceButtons}>
				<TouchableOpacity
					style={styles.deviceButton}
					onPress={() => setShowCameraSelector(true)}
					disabled={cameras.length === 0}
				>
					<CameraIcon color={cameras.length > 0 ? "#2563eb" : "#9ca3af"} />
					<Text
						style={[
							styles.deviceButtonText,
							cameras.length === 0 && styles.deviceButtonTextDisabled,
						]}
						numberOfLines={1}
					>
						{cameras.length > 0 ? "Camera" : "No cameras"}
					</Text>
				</TouchableOpacity>

				<TouchableOpacity
					style={styles.deviceButton}
					onPress={() => setShowMicSelector(true)}
					disabled={microphones.length === 0}
				>
					<MicIcon color={microphones.length > 0 ? "#2563eb" : "#9ca3af"} />
					<Text
						style={[
							styles.deviceButtonText,
							microphones.length === 0 && styles.deviceButtonTextDisabled,
						]}
						numberOfLines={1}
					>
						{microphones.length > 0 ? "Microphone" : "No mics"}
					</Text>
				</TouchableOpacity>
			</View>

			{/* Name input */}
			<TextInput
				style={styles.nameInput}
				placeholder="Enter your name"
				placeholderTextColor="#9ca3af"
				value={displayName}
				onChangeText={setDisplayName}
				autoCapitalize="words"
				autoCorrect={false}
				returnKeyType="done"
				onSubmitEditing={handleJoin}
			/>

			{/* Join button */}
			<TouchableOpacity
				style={[styles.joinButton, !canJoin && styles.joinButtonDisabled]}
				onPress={handleJoin}
				disabled={!canJoin}
				activeOpacity={0.8}
			>
				<Text
					style={[
						styles.joinButtonText,
						!canJoin && styles.joinButtonTextDisabled,
					]}
				>
					Join
				</Text>
			</TouchableOpacity>

			{/* Permission hint */}
			{!hasRequiredPermissions && !isChecking && (
				<TouchableOpacity style={styles.permissionButton} onPress={requestPermissions}>
					<Text style={styles.permissionButtonText}>
						Grant camera & mic access
					</Text>
				</TouchableOpacity>
			)}

			{/* Device selectors */}
			<DeviceSelector
				visible={showCameraSelector}
				devices={cameras}
				selectedId={selectedCamera ?? undefined}
				onSelect={handleCameraSelect}
				onClose={() => setShowCameraSelector(false)}
				type="video"
			/>

			<DeviceSelector
				visible={showMicSelector}
				devices={microphones}
				selectedId={selectedMicrophone ?? undefined}
				onSelect={handleMicSelect}
				onClose={() => setShowMicSelector(false)}
				type="audio"
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111827", // gray-900
		paddingHorizontal: 24,
		paddingVertical: 32,
	},
	header: {
		alignItems: "center",
		marginBottom: 24,
	},
	roomLabel: {
		fontSize: 12,
		color: "#9ca3af", // gray-400
		textTransform: "uppercase",
		letterSpacing: 1,
		marginBottom: 4,
	},
	roomId: {
		fontSize: 16,
		color: "#f9fafb", // gray-50
		fontWeight: "500",
	},
	previewContainer: {
		flex: 1,
		borderRadius: 16,
		overflow: "hidden",
		backgroundColor: "#1f2937", // gray-800
		marginBottom: 20,
	},
	videoPreview: {
		flex: 1,
	},
	avatarContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	permissionHint: {
		marginTop: 16,
		fontSize: 14,
		color: "#9ca3af", // gray-400
	},
	deviceButtons: {
		flexDirection: "row",
		justifyContent: "center",
		gap: 16,
		marginBottom: 20,
	},
	deviceButton: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#1f2937", // gray-800
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 8,
		gap: 8,
	},
	deviceButtonText: {
		fontSize: 14,
		color: "#2563eb", // blue-600
		fontWeight: "500",
	},
	deviceButtonTextDisabled: {
		color: "#9ca3af", // gray-400
	},
	nameInput: {
		backgroundColor: "#1f2937", // gray-800
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 14,
		fontSize: 16,
		color: "#f9fafb", // gray-50
		marginBottom: 16,
		borderWidth: 1,
		borderColor: "#374151", // gray-700
	},
	joinButton: {
		backgroundColor: "#2563eb", // blue-600
		borderRadius: 12,
		paddingVertical: 16,
		alignItems: "center",
	},
	joinButtonDisabled: {
		backgroundColor: "#374151", // gray-700
	},
	joinButtonText: {
		fontSize: 16,
		fontWeight: "600",
		color: "#ffffff",
	},
	joinButtonTextDisabled: {
		color: "#6b7280", // gray-500
	},
	permissionButton: {
		marginTop: 12,
		alignItems: "center",
		paddingVertical: 8,
	},
	permissionButtonText: {
		fontSize: 14,
		color: "#60a5fa", // blue-400
		textDecorationLine: "underline",
	},
});

const iconStyles = StyleSheet.create({
	cameraContainer: {
		width: 20,
		height: 20,
		justifyContent: "center",
		alignItems: "center",
	},
	cameraBody: {
		width: 14,
		height: 10,
		borderWidth: 2,
		borderRadius: 2,
	},
	cameraLens: {
		position: "absolute",
		right: 0,
		width: 0,
		height: 0,
		borderLeftWidth: 4,
		borderTopWidth: 3,
		borderBottomWidth: 3,
		borderTopColor: "transparent",
		borderBottomColor: "transparent",
	},
	micContainer: {
		width: 20,
		height: 20,
		justifyContent: "flex-end",
		alignItems: "center",
	},
	micHead: {
		width: 8,
		height: 12,
		borderWidth: 2,
		borderRadius: 4,
		marginBottom: -2,
	},
	micStand: {
		width: 2,
		height: 4,
	},
	micBase: {
		width: 8,
		height: 2,
		borderRadius: 1,
	},
});
