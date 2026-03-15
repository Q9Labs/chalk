import { HugeiconsIcon } from "@hugeicons/react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";
import { 
  Mic01Icon, 
  MicOff01Icon, 
  Video01Icon, 
  VideoOffIcon, 
  Settings01Icon, 
  ArrowRight01Icon,
  Sun01Icon,
  Moon01Icon
} from "@hugeicons/core-free-icons";
import { useMemo, useState, useRef } from "react";
import { Animated, KeyboardAvoidingView, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePreJoinPreview } from "../hooks/usePreJoinPreview";
import { Theme } from "../ui/theme";

export interface NativeJoinSettings {
  displayName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface NativePreJoinLobbyProps {
  roomName: string;
  role?: "host" | "participant";
  userName?: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  error?: string | null;
  logo?: React.ReactNode;
  onJoin: (settings: NativeJoinSettings) => void;
  onCancel?: () => void;
}

export function NativePreJoinLobby({
  roomName,
  role = "participant",
  userName = role === "host" ? "Host" : "Guest",
  initialAudioEnabled = true,
  initialVideoEnabled = true,
  error,
  logo,
  onJoin,
  onCancel,
}: NativePreJoinLobbyProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const previewLabel = useMemo(() => (displayName.trim().charAt(0) || "C").toUpperCase(), [displayName]);
  const { previewError, previewStream } = usePreJoinPreview(videoEnabled);

  // Swipe to Join State
  const pan = useRef(new Animated.Value(0)).current;
  const swipeContainerWidth = useRef(0);
  const swipeHandleWidth = 64;
  const joinTriggered = useRef(false);

  const handleJoin = () => {
    if (joinTriggered.current) return;
    joinTriggered.current = true;
    onJoin({
      displayName,
      audioEnabled,
      videoEnabled,
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.stopAnimation();
      },
      onPanResponderMove: (_, gesture) => {
        if (swipeContainerWidth.current > 0 && !joinTriggered.current) {
          const maxX = swipeContainerWidth.current - swipeHandleWidth;
          const newX = Math.max(0, Math.min(gesture.dx, maxX));
          pan.setValue(newX);
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (joinTriggered.current) return;
        
        const maxX = swipeContainerWidth.current - swipeHandleWidth;
        // Trigger join if swiped more than 75%
        if (gesture.dx > maxX * 0.75) {
          Animated.spring(pan, {
            toValue: maxX,
            useNativeDriver: false,
            bounciness: 0,
          }).start(() => {
            handleJoin();
          });
        } else {
          Animated.spring(pan, {
            toValue: 0,
            useNativeDriver: false,
            friction: 6,
          }).start();
        }
      },
    })
  ).current;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.screen}>
      <View style={styles.content}>
        
        <View style={styles.header}>
          <Pressable onPress={onCancel} style={styles.brandRow}>
            {logo ? logo : (
              <View style={styles.logoPlaceholder}>
                <Text style={styles.brandText}>chalk</Text>
              </View>
            )}
            {!logo && <Text style={styles.brandText}>chalk</Text>}
          </Pressable>

          <View style={styles.headerDivider} />

          <Text style={styles.headerTitle} numberOfLines={1}>
            {roomName || "Meeting On Chalk"}
          </Text>

          <Pressable onPress={() => setIsDarkMode((current) => !current)} style={styles.themeButton}>
            <HugeiconsIcon icon={isDarkMode ? Sun01Icon : Moon01Icon} size={22} color="white" />
          </Pressable>
        </View>

        <View style={styles.previewIslandContainer}>
          <View style={styles.previewGlow} />
          <View style={styles.previewIsland}>
            {previewStream ? <RTCView mirror objectFit="cover" streamURL={previewStream.toURL()} style={styles.previewVideo} zOrder={0} /> : null}
            <View style={styles.previewShade} />
            
            <View style={styles.islandHeader}>
              <View style={styles.islandBadge}>
                <View style={styles.islandBadgeDot} />
                <Text style={styles.islandBadgeText}>{role === "host" ? "Host" : "Guest"}</Text>
              </View>
              <Pressable style={styles.islandSettingsButton}>
                <HugeiconsIcon icon={Settings01Icon} size={20} color="white" />
              </Pressable>
            </View>

            {!previewStream ? (
              <View style={styles.islandAvatar}>
                <View style={styles.eyesRow}>
                  <View style={styles.eyeDot} />
                  <View style={styles.eyeDot} />
                </View>
                <Text style={styles.islandAvatarText}>{previewLabel}</Text>
              </View>
            ) : <View style={styles.previewSpacer} />}

            <View style={styles.islandControls}>
              <Pressable onPress={() => setAudioEnabled(!audioEnabled)} style={[styles.islandToggle, !audioEnabled && styles.islandToggleOff]}>
                <HugeiconsIcon 
                  icon={audioEnabled ? Mic01Icon : MicOff01Icon} 
                  size={24} 
                  color={audioEnabled ? "#000" : "#fff"} 
                />
              </Pressable>
              <Pressable onPress={() => setVideoEnabled(!videoEnabled)} style={[styles.islandToggle, !videoEnabled && styles.islandToggleOff]}>
                <HugeiconsIcon 
                  icon={videoEnabled ? Video01Icon : VideoOffIcon} 
                  size={24} 
                  color={videoEnabled ? "#000" : "#fff"} 
                />
              </Pressable>
            </View>

          </View>
        </View>

        <View style={styles.detailsContainer}>
          <Text style={styles.roomTitle} numberOfLines={2}>{roomName || "Meeting On Chalk"}</Text>
          
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Name</Text>
            <TextInput
              onChangeText={setDisplayName}
              placeholder="Enter your name"
              placeholderTextColor="rgba(255,255,255,0.3)"
              style={styles.minimalInput}
              value={displayName}
              maxLength={30}
              returnKeyType="done"
            />
          </View>
          
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {previewError && videoEnabled ? <Text style={styles.error}>Camera preview unavailable: {previewError}</Text> : null}
        </View>

        <View style={styles.swipeArea}>
          <View 
            style={styles.swipeTrack} 
            onLayout={(e) => { swipeContainerWidth.current = e.nativeEvent.layout.width; }}
          >
            <Text style={styles.swipePlaceholderText}>Swipe to join</Text>
            
            <Animated.View
              style={[
                styles.swipeHandle,
                { transform: [{ translateX: pan }] }
              ]}
              {...panResponder.panHandlers}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} size={28} color="#000" />
            </Animated.View>
          </View>
        </View>

      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#030406",
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 40,
    justifyContent: "space-between",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    height: 48,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  brandText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.5,
    textTransform: "lowercase",
  },
  headerDivider: {
    width: 1,
    height: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  headerTitle: {
    flex: 1,
    color: "rgba(255,255,255,0.85)",
    fontSize: 16,
    fontWeight: "600",
  },
  themeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  
  previewIslandContainer: {
    flex: 1, // Let it take available space without scrolling
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 10,
    position: "relative",
  },
  previewGlow: {
    position: "absolute",
    width: "100%",
    maxWidth: 380,
    aspectRatio: 0.85,
    backgroundColor: "#22c55e",
    borderRadius: 48,
    opacity: 0.15,
    transform: [{ scale: 1.05 }],
  },
  previewIsland: {
    width: "100%",
    maxWidth: 380,
    aspectRatio: 0.85,
    backgroundColor: "#26c95b",
    borderRadius: 48,
    overflow: "hidden",
    padding: 24,
    justifyContent: "space-between",
    shadowColor: "#19ff7f",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 30,
    elevation: 10,
    borderCurve: "continuous",
  },
  previewVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  previewShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.14)",
  },
  islandHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    zIndex: 2,
  },
  islandBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  islandBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#4ade80",
  },
  islandBadgeText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  islandSettingsButton: {
    backgroundColor: "rgba(0,0,0,0.3)",
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  islandAvatar: {
    alignSelf: "center",
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  previewSpacer: {
    flex: 1,
  },
  eyesRow: {
    flexDirection: "row",
    gap: 40,
    marginBottom: 4,
    marginTop: -10,
  },
  eyeDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#ffffff",
  },
  islandAvatarText: {
    color: "#fff",
    fontSize: 56,
    fontWeight: "500",
  },
  islandControls: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    zIndex: 2,
  },
  islandToggle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  islandToggleOff: {
    backgroundColor: "#ef4444", // Bright red for high contrast
  },

  detailsContainer: {
    marginVertical: 10,
    gap: 16,
  },
  roomTitle: {
    color: "#fff",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -1,
  },
  inputGroup: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 2,
    borderColor: "rgba(255,255,255,0.1)",
    paddingBottom: 8,
  },
  inputLabel: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 18,
    fontWeight: "600",
    marginRight: 16,
  },
  minimalInput: {
    flex: 1,
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    padding: 0,
  },
  error: {
    color: "#ef4444",
    fontSize: 14,
    fontWeight: "600",
  },

  swipeArea: {
    marginTop: 10,
  },
  swipeTrack: {
    height: 72,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 36,
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.04)",
  },
  swipePlaceholderText: {
    position: "absolute",
    width: "100%",
    textAlign: "center",
    color: "rgba(255,255,255,0.5)",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  swipeHandle: {
    width: 64,
    height: 64,
    backgroundColor: "#22c55e",
    borderRadius: 32,
    position: "absolute",
    left: 4,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#22c55e",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 10,
  },
});
