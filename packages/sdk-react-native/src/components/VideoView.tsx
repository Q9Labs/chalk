/**
 * VideoView component - Native video renderer for React Native
 * Displays a media stream using react-native-webrtc RTCView
 */

import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { RTCView } from "react-native-webrtc";

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
			return <View style={[styles.placeholder, style]} testID={testID} />;
		}

		return (
			<RTCView
				ref={ref}
				streamURL={(stream as unknown as { toURL(): string }).toURL()}
				style={[styles.video, style]}
				mirror={mirror}
				objectFit={objectFit}
				zOrder={zOrder}
				testID={testID}
			/>
		);
	},
);

VideoView.displayName = "VideoView";

const styles = StyleSheet.create({
	video: {
		flex: 1,
		backgroundColor: "#000",
	},
	placeholder: {
		flex: 1,
		backgroundColor: "#1a1a1a",
	},
});
