/**
 * MeetingRoom - Turnkey component for active video conference
 * Combines VideoGrid, ControlBar, ChatPanel in BottomSheet, and ScreenShareView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, Dimensions, Modal, Platform, StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from "react-native";
import { useChat } from "../../hooks/useChat";
import { CHALK_THEME } from "../../theme";
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
    BottomSheetComponent = bottomSheet?.default ?? bottomSheet;
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

// Fallback version if not injected
const SDK_VERSION = "0.0.57";

interface DebugModalProps {
  visible: boolean;
  onClose: () => void;
  wsStatus: string;
  wsColor: string;
  roomInfo?: any;
}

function DebugModal({ visible, onClose, wsStatus, wsColor, roomInfo }: DebugModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const { width, height } = Dimensions.get("window");
    const info = `
	Chalk RN SDK Debug Info
	-----------------------
	SDK Version: ${SDK_VERSION}
	Platform: ${Platform.OS} ${Platform.Version}
	WS Status: ${wsStatus}
	Room ID: ${roomInfo?.roomId || "N/A"}
	Participant ID: ${roomInfo?.participantId || "N/A"}
	Screen: ${width}x${height}
	`.trim();

    Clipboard.setString(info);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [wsStatus, roomInfo]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.debugOverlay}>
        <View style={styles.debugContent}>
          <View style={styles.debugHeader}>
            <Text style={styles.debugTitle}>System Information</Text>
            <TouchableOpacity onPress={onClose} style={styles.debugCloseBtn}>
              <Text style={styles.debugCloseText}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.debugBody}>
            <View style={styles.debugSection}>
              <Text style={styles.debugLabel}>BUILD & SDK</Text>
              <Text style={styles.debugValue}>Version: {SDK_VERSION}</Text>
              <Text style={styles.debugValue}>
                Platform: {Platform.OS} {Platform.Version}
              </Text>
            </View>

            <View style={styles.debugSection}>
              <Text style={styles.debugLabel}>WS STATUS</Text>
              <View style={styles.debugRow}>
                <View style={[styles.wsStatusDot, { backgroundColor: wsColor }]} />
                <Text style={[styles.debugValue, { color: wsColor }]}>{wsStatus}</Text>
              </View>
            </View>

            <View style={styles.debugSection}>
              <Text style={styles.debugLabel}>MEETING INFO</Text>
              <Text style={styles.debugValue}>Room: {roomInfo?.roomId || "N/A"}</Text>
              <Text style={styles.debugValue}>User: {roomInfo?.participantId || "N/A"}</Text>
            </View>
          </View>

          <TouchableOpacity style={[styles.copyBtn, copied && { backgroundColor: CHALK_THEME.colors.status.success }]} onPress={handleCopy}>
            <Text style={styles.copyBtnText}>{copied ? "Copied!" : "Copy Debug Bundle"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export function MeetingRoom({ onLeave, style }: MeetingRoomProps) {
  const { leaveRoom, roomInfo, wsConnectionState } = useChalk();
  const { participants, localParticipant } = useParticipants();
  const { isVideoEnabled, isAudioEnabled, toggleVideo, toggleAudio } = useMedia();
  const { isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();
  const { messages, sendMessage } = useChat();

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
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
  const screenSharer = useMemo(() => participants.find((p) => p.isScreenSharing), [participants]);

  // Create MediaStream from screen share track
  const screenShareStream = useMemo(() => createStreamFromTrack(screenSharer?.videoTrack), [screenSharer?.videoTrack]);

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

  const wsStatusLabel = useMemo(() => {
    switch (wsConnectionState) {
      case "connected":
        return "WS Connected";
      case "connecting":
        return "WS Connecting";
      case "reconnecting":
        return "WS Reconnecting";
      case "failed":
        return "WS Failed";
      default:
        return "WS Disconnected";
    }
  }, [wsConnectionState]);

  const wsStatusColor = useMemo(() => {
    switch (wsConnectionState) {
      case "connected":
        return CHALK_THEME.colors.status.success;
      case "connecting":
      case "reconnecting":
        return CHALK_THEME.colors.status.warning;
      case "failed":
        return CHALK_THEME.colors.status.error;
      default:
        return CHALK_THEME.colors.text.muted;
    }
  }, [wsConnectionState]);

  return (
    <View style={[styles.container, style]}>
      <TouchableOpacity style={styles.wsStatusBadge} onPress={() => setIsDebugOpen(true)} activeOpacity={0.7}>
        <View style={[styles.wsStatusDot, { backgroundColor: wsStatusColor }]} />
        <Text style={styles.wsStatusText}>{wsStatusLabel}</Text>
      </TouchableOpacity>

      <DebugModal visible={isDebugOpen} onClose={() => setIsDebugOpen(false)} wsStatus={wsStatusLabel} wsColor={wsStatusColor} roomInfo={roomInfo} />

      {/* Main content area */}
      <View style={styles.content}>
        {screenShareStream ? (
          // Screen share active - show screen share prominently
          <View style={styles.screenShareLayout}>
            <View style={styles.screenShareContainer}>
              <ScreenShareView stream={screenShareStream} style={styles.screenShare} />
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
        <ControlBar isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isChatOpen={isChatOpen} onToggleAudio={toggleAudio} onToggleVideo={toggleVideo} onToggleScreenShare={handleToggleScreenShare} onToggleChat={handleToggleChat} onLeave={handleLeave} />
      </View>

      {/* Chat panel - use BottomSheet if available, otherwise Modal */}
      {useBottomSheet && BottomSheetComponent ? (
        <BottomSheetComponent ref={bottomSheetRef} index={-1} snapPoints={snapPoints} enablePanDownToClose onChange={handleBottomSheetChange} backgroundStyle={styles.bottomSheetBackground} handleIndicatorStyle={styles.bottomSheetHandle}>
          {BottomSheetViewComponent && (
            <BottomSheetViewComponent style={styles.bottomSheetContent}>
              <ChatPanel messages={messages} onSend={sendMessage} localUserId={localParticipant?.id ?? roomInfo?.participantId} style={styles.chatPanel} />
            </BottomSheetViewComponent>
          )}
        </BottomSheetComponent>
      ) : (
        <Modal visible={isChatOpen} animationType="slide" transparent onRequestClose={() => setIsChatOpen(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Chat</Text>
                <TouchableOpacity onPress={() => setIsChatOpen(false)}>
                  <Text style={styles.modalClose}>Close</Text>
                </TouchableOpacity>
              </View>
              <ChatPanel messages={messages} onSend={sendMessage} localUserId={localParticipant?.id ?? roomInfo?.participantId} style={styles.chatPanel} />
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
    backgroundColor: CHALK_THEME.colors.background,
  },
  wsStatusBadge: {
    position: "absolute",
    top: CHALK_THEME.spacing.md,
    right: CHALK_THEME.spacing.md,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: CHALK_THEME.colors.ui.pillBg,
    borderColor: CHALK_THEME.colors.ui.pillBorder,
    borderWidth: 1,
    borderRadius: CHALK_THEME.borderRadius.full,
    paddingHorizontal: CHALK_THEME.spacing.sm,
    paddingVertical: 6,
    // Shadow for depth to indicate it's tappable
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  wsStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  wsStatusText: {
    fontSize: 12,
    color: CHALK_THEME.colors.text.secondary,
    fontWeight: "500",
  },
  // Debug Modal Styles
  debugOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: CHALK_THEME.spacing.xl,
  },
  debugContent: {
    backgroundColor: CHALK_THEME.colors.background,
    borderRadius: CHALK_THEME.borderRadius.lg,
    width: "100%",
    maxWidth: 400,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: CHALK_THEME.colors.ui.border,
  },
  debugHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: CHALK_THEME.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: CHALK_THEME.colors.ui.border,
  },
  debugTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: CHALK_THEME.colors.text.primary,
  },
  debugCloseBtn: {
    padding: 4,
  },
  debugCloseText: {
    fontSize: 18,
    color: CHALK_THEME.colors.text.muted,
  },
  debugBody: {
    padding: CHALK_THEME.spacing.md,
  },
  debugSection: {
    marginBottom: CHALK_THEME.spacing.md,
  },
  debugLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: CHALK_THEME.colors.text.muted,
    letterSpacing: 1,
    marginBottom: 4,
  },
  debugValue: {
    fontSize: 13,
    color: CHALK_THEME.colors.text.primary,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  debugRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  copyBtn: {
    backgroundColor: CHALK_THEME.colors.primary,
    paddingVertical: CHALK_THEME.spacing.md,
    alignItems: "center",
  },
  copyBtnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
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
    padding: CHALK_THEME.spacing.sm,
  },
  screenShare: {
    flex: 1,
    borderRadius: CHALK_THEME.borderRadius.md,
    overflow: "hidden",
  },
  participantStrip: {
    flex: 1,
    paddingHorizontal: CHALK_THEME.spacing.sm,
    paddingBottom: CHALK_THEME.spacing.sm,
  },
  controlBarContainer: {
    paddingHorizontal: CHALK_THEME.spacing.md,
    paddingBottom: 24,
    paddingTop: CHALK_THEME.spacing.sm,
    alignItems: "center",
  },
  bottomSheetBackground: {
    backgroundColor: CHALK_THEME.colors.background,
    borderTopLeftRadius: CHALK_THEME.borderRadius.lg,
    borderTopRightRadius: CHALK_THEME.borderRadius.lg,
  },
  bottomSheetHandle: {
    backgroundColor: CHALK_THEME.colors.ui.border,
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
    backgroundColor: CHALK_THEME.colors.ui.overlay,
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: CHALK_THEME.colors.background,
    borderTopLeftRadius: CHALK_THEME.borderRadius.lg,
    borderTopRightRadius: CHALK_THEME.borderRadius.lg,
    height: "60%",
    paddingTop: CHALK_THEME.spacing.sm,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: CHALK_THEME.spacing.md,
    paddingVertical: CHALK_THEME.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: CHALK_THEME.colors.ui.border,
  },
  modalTitle: {
    fontSize: CHALK_THEME.typography.sizes.lg,
    fontWeight: "600",
    color: CHALK_THEME.colors.text.primary,
  },
  modalClose: {
    fontSize: CHALK_THEME.typography.sizes.md,
    color: CHALK_THEME.colors.primary,
  },
});
