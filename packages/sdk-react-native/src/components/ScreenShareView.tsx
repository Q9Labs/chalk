/**
 * ScreenShareView component - Displays shared screen in React Native
 * Similar to VideoView but optimized for screen content
 */

import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";

interface ScreenShareViewProps {
	/** MediaStream of the screen share */
	stream: MediaStream | null;
	/** How to fit the screen content */
	objectFit?: "contain" | "cover";
	/** Custom styles */
	style?: ViewStyle;
	/** Z-order for layering */
	zOrder?: number;
	/** Test ID for testing purposes */
	testID?: string;
}

/**
 * ScreenShareView renders a shared screen stream
 * Typically displayed in a larger area than participant videos
 *
 * @example
 * ```tsx
 * const { participants } = useParticipants();
 * const screenSharer = participants.find(p => p.isScreenSharing);
 *
 * if (screenSharer?.videoTrack) {
 *   const stream = new MediaStream([screenSharer.videoTrack]);
 *   return <ScreenShareView stream={stream} style={{ flex: 1 }} />;
 * }
 * ```
 */
export const ScreenShareView = React.forwardRef<View, ScreenShareViewProps>(
	({ stream, objectFit = "contain", style, zOrder = 1, testID }, ref) => {
		if (!stream) {
			return <View style={[styles.placeholder, style]} testID={testID} />;
		}

		return (
			<RTCView
				ref={ref}
				streamURL={(stream as unknown as { toURL(): string }).toURL()}
				style={[styles.screenShare, style]}
				mirror={false}
				objectFit={objectFit}
				zOrder={zOrder}
				testID={testID}
			/>
		);
	},
);

ScreenShareView.displayName = "ScreenShareView";

const styles = StyleSheet.create({
	screenShare: {
		flex: 1,
		backgroundColor: "#000",
	},
	placeholder: {
		flex: 1,
		backgroundColor: "#1a1a1a",
		justifyContent: "center",
		alignItems: "center",
	},
});
