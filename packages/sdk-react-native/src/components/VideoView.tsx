/**
 * VideoView component - Native video renderer for React Native
 * Displays a media stream using react-native-webrtc RTCView
 */

import React from "react";
import { StyleSheet, View, Text, Platform, type ViewStyle } from "react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";

interface VideoViewProps {
	/** MediaStream to display */
	stream: MediaStream | null;
	/** Mirror the video horizontally (typically used for front camera) */
	mirror?: boolean;
	/** How to fit the video content */
	objectFit?: "contain" | "cover";
	/** Custom styles */
	style?: ViewStyle;
	/** Z-order for layering */
	zOrder?: number;
	/** Test ID for testing purposes */
	testID?: string;
}

/**
 * VideoView renders a media stream using the native RTCView component
 *
 * @example
 * ```tsx
 * const { localVideoTrack } = useMedia();
 * const stream = new MediaStream([localVideoTrack]);
 *
 * return (
 *   <VideoView
 *     stream={stream}
 *     mirror={true}
 *     style={{ flex: 1 }}
 *   />
 * );
 * ```
 */
export const VideoView = React.forwardRef<View, VideoViewProps>(
	(
		{ stream, mirror = false, objectFit = "cover", style, zOrder = 0, testID },
		ref,
	) => {
		if (!stream) {
			console.log("[VideoView] No stream provided");
			return (
				<View style={[styles.placeholder, style]} testID={testID}>
					<Text style={styles.placeholderText}>No camera stream</Text>
				</View>
			);
		}

		const streamURL = (stream as unknown as { toURL(): string }).toURL();
		console.log("[VideoView] Rendering stream:", { streamURL, hasToURL: typeof (stream as unknown as { toURL(): string }).toURL === 'function' });

		return (
			<View style={[styles.container, style]}>
				<RTCView
					ref={ref}
					streamURL={streamURL}
					style={styles.video}
					mirror={mirror}
					objectFit={objectFit}
					zOrder={zOrder}
					testID={testID}
				/>
				{/* Show helpful message on simulator where camera isn't available */}
				{Platform.OS === "ios" && __DEV__ && (
					<View style={styles.simulatorOverlay}>
						<Text style={styles.simulatorText}>
							📱 Camera unavailable on simulator
						</Text>
						<Text style={styles.simulatorSubtext}>
							Test with physical device to see video stream
						</Text>
					</View>
				)}
			</View>
		);
	},
);

VideoView.displayName = "VideoView";

const styles = StyleSheet.create({
	container: {
		flex: 1,
		position: "relative",
	},
	video: {
		flex: 1,
		backgroundColor: "#000",
	},
	placeholder: {
		flex: 1,
		backgroundColor: "#1a1a1a",
		justifyContent: "center",
		alignItems: "center",
	},
	placeholderText: {
		color: "rgba(255,255,255,0.5)",
		fontSize: 14,
	},
	simulatorOverlay: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		backgroundColor: "rgba(0,0,0,0.7)",
		paddingVertical: 12,
		paddingHorizontal: 16,
		alignItems: "center",
	},
	simulatorText: {
		color: "#fff",
		fontSize: 13,
		fontWeight: "600",
		marginBottom: 4,
	},
	simulatorSubtext: {
		color: "rgba(255,255,255,0.6)",
		fontSize: 11,
	},
});
