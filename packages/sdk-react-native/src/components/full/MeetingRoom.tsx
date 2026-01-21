/**
 * MeetingRoom - Turnkey component for active video conference
 * Combines VideoGrid, ControlBar, ChatPanel in BottomSheet, and ScreenShareView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Modal,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import { useChat } from "../../hooks/useChat";
import { useMedia } from "../../hooks/useMedia";
import { useParticipants } from "../../hooks/useParticipants";
import { useScreenShare } from "../../hooks/useScreenShare";
import { useChalk } from "../../ChalkProvider";
import { ChatPanel } from "../composite/ChatPanel";
import { ControlBar } from "../composite/ControlBar";
import { ScreenShareView } from "../ScreenShareView";
import { VideoGrid } from "../VideoGrid";

// Lazy load BottomSheet to avoid crash before GestureHandlerRootView mounts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BottomSheetComponent: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BottomSheetViewComponent: any = null;
let bottomSheetLoaded = false;

function loadBottomSheet() {
	if (bottomSheetLoaded) return;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const bottomSheet = require("@gorhom/bottom-sheet");
		BottomSheetComponent = bottomSheet.default;
		BottomSheetViewComponent = bottomSheet.BottomSheetView;
		bottomSheetLoaded = true;
	} catch {
		// Bottom sheet not available - will use fallback
	}
}

// Dynamic require for MediaStream constructor (not available as type-only import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MediaStreamClass: { new (tracks?: unknown[]): any } | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	MediaStreamClass = require("@cloudflare/react-native-webrtc").MediaStream;
} catch {
	// Native module not available
}

/** Creates a MediaStream from a track for rendering */
function createStreamFromTrack(track: unknown): MediaStream | null {
	if (!track || !MediaStreamClass) return null;
	try {
		const stream = new MediaStreamClass();
		stream.addTrack(track);
		return stream as MediaStream;
	} catch {
		return null;
	}
}

interface MeetingRoomProps {
	/** Callback when user leaves the meeting */
	onLeave: () => void;
	/** Additional container styles */
	style?: ViewStyle;
}

export function MeetingRoom({ onLeave, style }: MeetingRoomProps) {
	const { leaveRoom, roomInfo } = useChalk();
	const { participants, localParticipant } = useParticipants();
	const { isVideoEnabled, isAudioEnabled, toggleVideo, toggleAudio } = useMedia();
	const { isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();
	const { messages, sendMessage } = useChat();

	const [isChatOpen, setIsChatOpen] = useState(false);
	const [useBottomSheet, setUseBottomSheet] = useState(false);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const bottomSheetRef = useRef<any>(null);
	const snapPoints = useMemo(() => ["50%", "90%"], []);

	// Load BottomSheet lazily after component mounts (after GestureHandlerRootView)
	useEffect(() => {
		loadBottomSheet();
		setUseBottomSheet(bottomSheetLoaded && BottomSheetComponent !== null);
	}, []);

	// Find participant who is screen sharing (if any)
	const screenSharer = useMemo(
		() => participants.find((p) => p.isScreenSharing),
		[participants],
	);

	// Create MediaStream from screen share track
	const screenShareStream = useMemo(
		() => createStreamFromTrack(screenSharer?.videoTrack),
		[screenSharer?.videoTrack],
	);

	const handleToggleChat = useCallback(() => {
		setIsChatOpen((prev) => {
			const next = !prev;
			if (next) {
				bottomSheetRef.current?.snapToIndex(0);
			} else {
				bottomSheetRef.current?.close();
			}
			return next;
		});
	}, []);

	const handleToggleScreenShare = useCallback(async () => {
		if (isScreenSharing) {
			await stopScreenShare();
		} else {
			await startScreenShare();
		}
	}, [isScreenSharing, startScreenShare, stopScreenShare]);

	const handleLeave = useCallback(async () => {
		await leaveRoom();
		onLeave();
	}, [leaveRoom, onLeave]);

	const handleBottomSheetChange = useCallback((index: number) => {
		setIsChatOpen(index >= 0);
	}, []);

	return (
		<View style={[styles.container, style]}>
			{/* Main content area */}
			<View style={styles.content}>
				{screenShareStream ? (
					// Screen share active - show screen share prominently
					<View style={styles.screenShareLayout}>
						<View style={styles.screenShareContainer}>
							<ScreenShareView
								stream={screenShareStream}
								style={styles.screenShare}
							/>
						</View>
						{/* Small video grid for participants */}
						<View style={styles.participantStrip}>
							<VideoGrid participants={participants} gap={4} />
						</View>
					</View>
				) : (
					// Normal layout - video grid fills space
					<VideoGrid participants={participants} style={styles.videoGrid} />
				)}
			</View>

			{/* Control bar at bottom */}
			<View style={styles.controlBarContainer}>
				<ControlBar
					isAudioEnabled={isAudioEnabled}
					isVideoEnabled={isVideoEnabled}
					isScreenSharing={isScreenSharing}
					isChatOpen={isChatOpen}
					onToggleAudio={toggleAudio}
					onToggleVideo={toggleVideo}
					onToggleScreenShare={handleToggleScreenShare}
					onToggleChat={handleToggleChat}
					onLeave={handleLeave}
				/>
			</View>

			{/* Chat panel - use BottomSheet if available, otherwise Modal */}
			{useBottomSheet && BottomSheetComponent ? (
				<BottomSheetComponent
					ref={bottomSheetRef}
					index={-1}
					snapPoints={snapPoints}
					enablePanDownToClose
					onChange={handleBottomSheetChange}
					backgroundStyle={styles.bottomSheetBackground}
					handleIndicatorStyle={styles.bottomSheetHandle}
				>
					{BottomSheetViewComponent && (
						<BottomSheetViewComponent style={styles.bottomSheetContent}>
							<ChatPanel
								messages={messages}
								onSend={sendMessage}
								localUserId={localParticipant?.id ?? roomInfo?.participantId}
								style={styles.chatPanel}
							/>
						</BottomSheetViewComponent>
					)}
				</BottomSheetComponent>
			) : (
				<Modal
					visible={isChatOpen}
					animationType="slide"
					transparent
					onRequestClose={() => setIsChatOpen(false)}
				>
					<View style={styles.modalOverlay}>
						<View style={styles.modalContent}>
							<View style={styles.modalHeader}>
								<Text style={styles.modalTitle}>Chat</Text>
								<TouchableOpacity onPress={() => setIsChatOpen(false)}>
									<Text style={styles.modalClose}>Close</Text>
								</TouchableOpacity>
							</View>
							<ChatPanel
								messages={messages}
								onSend={sendMessage}
								localUserId={localParticipant?.id ?? roomInfo?.participantId}
								style={styles.chatPanel}
							/>
						</View>
					</View>
				</Modal>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111827", // gray-900
	},
	content: {
		flex: 1,
	},
	videoGrid: {
		flex: 1,
	},
	screenShareLayout: {
		flex: 1,
	},
	screenShareContainer: {
		flex: 3,
		padding: 8,
	},
	screenShare: {
		flex: 1,
		borderRadius: 8,
		overflow: "hidden",
	},
	participantStrip: {
		flex: 1,
		paddingHorizontal: 8,
		paddingBottom: 8,
	},
	controlBarContainer: {
		paddingHorizontal: 16,
		paddingBottom: 24,
		paddingTop: 8,
		alignItems: "center",
	},
	bottomSheetBackground: {
		backgroundColor: "#ffffff",
		borderTopLeftRadius: 16,
		borderTopRightRadius: 16,
	},
	bottomSheetHandle: {
		backgroundColor: "#d1d5db", // gray-300
		width: 40,
	},
	bottomSheetContent: {
		flex: 1,
	},
	chatPanel: {
		flex: 1,
	},
	// Modal fallback styles
	modalOverlay: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.5)",
		justifyContent: "flex-end",
	},
	modalContent: {
		backgroundColor: "#ffffff",
		borderTopLeftRadius: 16,
		borderTopRightRadius: 16,
		height: "60%",
		paddingTop: 8,
	},
	modalHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: "#e5e7eb",
	},
	modalTitle: {
		fontSize: 18,
		fontWeight: "600",
		color: "#111827",
	},
	modalClose: {
		fontSize: 16,
		color: "#2563eb",
	},
});
