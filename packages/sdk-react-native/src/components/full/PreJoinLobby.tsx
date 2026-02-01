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
import { CHALK_THEME } from "../../theme";
import { useDevices } from "../../hooks/useDevices";
import { useLocalStream } from "../../hooks/useLocalStream";
import { usePermissions } from "../../hooks/usePermissions";
import { Avatar } from "../atomic/Avatar";
import { DeviceSelector } from "../composite/DeviceSelector";
import { VideoView } from "../VideoView";
import { CameraIcon, MicrophoneIcon } from "../../icons";

interface PreJoinLobbyProps {
	/** Callback when user taps join with their display name */
	onJoin: (displayName: string) => void;
	/** Optional room ID to display */
	roomId?: string;
	/** Initial display name */
	initialName?: string;
	/** Optional error message to display */
	error?: string;
	/** Additional container styles */
	style?: ViewStyle;
}

export function PreJoinLobby({
	onJoin,
	roomId,
	initialName = "",
	error,
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
					<CameraIcon
						size={20}
						color={cameras.length > 0 ? CHALK_THEME.colors.primary : CHALK_THEME.colors.text.muted}
					/>
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
					<MicrophoneIcon
						size={20}
						color={microphones.length > 0 ? CHALK_THEME.colors.primary : CHALK_THEME.colors.text.muted}
					/>
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
				placeholderTextColor={CHALK_THEME.colors.text.muted}
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

			{error && <Text style={styles.errorText}>{error}</Text>}

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
		backgroundColor: CHALK_THEME.colors.background,
		paddingHorizontal: CHALK_THEME.spacing.lg,
		paddingVertical: CHALK_THEME.spacing.xl,
	},
	header: {
		alignItems: "center",
		marginBottom: CHALK_THEME.spacing.lg,
	},
	roomLabel: {
		fontSize: 12,
		color: CHALK_THEME.colors.text.muted,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginBottom: 4,
	},
	roomId: {
		fontSize: CHALK_THEME.typography.sizes.md,
		color: CHALK_THEME.colors.text.primary,
		fontWeight: "500",
	},
	previewContainer: {
		flex: 1,
		borderRadius: CHALK_THEME.borderRadius.lg,
		overflow: "hidden",
		backgroundColor: CHALK_THEME.colors.surface,
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
		color: CHALK_THEME.colors.text.muted,
	},
	deviceButtons: {
		flexDirection: "row",
		justifyContent: "center",
		gap: CHALK_THEME.spacing.md,
		marginBottom: 20,
	},
	deviceButton: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: CHALK_THEME.colors.surface,
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: 10,
		borderRadius: CHALK_THEME.borderRadius.md,
		gap: CHALK_THEME.spacing.sm,
	},
	deviceButtonText: {
		fontSize: 14,
		color: CHALK_THEME.colors.primary,
		fontWeight: "500",
	},
	deviceButtonTextDisabled: {
		color: CHALK_THEME.colors.text.muted,
	},
	nameInput: {
		backgroundColor: CHALK_THEME.colors.surface,
		borderRadius: CHALK_THEME.borderRadius.lg,
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: 14,
		fontSize: 16,
		color: CHALK_THEME.colors.text.primary,
		marginBottom: 16,
		borderWidth: 1,
		borderColor: CHALK_THEME.colors.ui.border,
	},
	joinButton: {
		backgroundColor: CHALK_THEME.colors.primary,
		borderRadius: CHALK_THEME.borderRadius.lg,
		paddingVertical: 16,
		alignItems: "center",
	},
	joinButtonDisabled: {
		backgroundColor: CHALK_THEME.colors.ui.pillBg,
		opacity: 0.5,
	},
	joinButtonText: {
		fontSize: 16,
		fontWeight: "600",
		color: CHALK_THEME.colors.text.inverse,
	},
	joinButtonTextDisabled: {
		color: CHALK_THEME.colors.text.muted,
	},
	errorText: {
		marginTop: 12,
		fontSize: 14,
		color: CHALK_THEME.colors.status.error,
		textAlign: "center",
	},
	permissionButton: {
		marginTop: 12,
		alignItems: "center",
		paddingVertical: 8,
	},
	permissionButtonText: {
		fontSize: 14,
		color: CHALK_THEME.colors.primary,
		textDecorationLine: "underline",
	},
});
