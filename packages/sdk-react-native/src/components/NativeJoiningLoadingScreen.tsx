import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, Platform } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";

export interface NativeJoiningLoadingScreenProps {
  displayName: string;
  message?: string;
  supportingMessages?: readonly string[];
}

export function NativeJoiningLoadingScreen({ displayName, message = "Joining room...", supportingMessages = [] }: NativeJoiningLoadingScreenProps): React.JSX.Element {
  const [messageIndex, setMessageIndex] = useState(0);
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (supportingMessages.length <= 1) {
      return;
    }

    const intervalId = setInterval(() => {
      setMessageIndex((current) => (current + 1) % supportingMessages.length);
    }, 2500);

    return () => clearInterval(intervalId);
  }, [supportingMessages]);

  useEffect(() => {
    // Rotation for the loading ring
    Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();

    // Initial fade in
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [rotateAnim, fadeAnim]);

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const activeSupportingMessage = supportingMessages[messageIndex] ?? "Initializing...";

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        {/* Centered Hero Section */}
        <View style={styles.heroWrapper}>
          <Animated.View style={[styles.ringContainer, { transform: [{ rotate: spin }] }]}>
            <Svg height="180" width="180" viewBox="0 0 100 100">
              <Circle cx="50" cy="50" r="48" stroke="rgba(255,255,255,0.05)" strokeWidth="2" fill="none" />
              <Circle cx="50" cy="50" r="48" stroke={Theme.colors.primary} strokeWidth="2" strokeDasharray="60 200" strokeLinecap="round" fill="none" />
            </Svg>
          </Animated.View>

          <View style={styles.avatarInner}>
            <NativeFaceAvatar name={displayName} size={120} />
          </View>
        </View>

        {/* Clean Typography */}
        <View style={styles.infoArea}>
          <Text style={styles.messageText}>{message}</Text>
          <Text style={styles.participantName}>{displayName}</Text>
        </View>

        {/* Subtle Supporting Label */}
        <View style={styles.statusBadge}>
          <View style={styles.dot} />
          <Text style={styles.supportingText}>{activeSupportingMessage}</Text>
        </View>
      </Animated.View>

      {/* Minimal Footer */}
      <View style={styles.footer}>
        <Text style={styles.brandText}>chalk</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#08080a", // Solid, professional dark
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 40,
  },
  heroWrapper: {
    width: 180,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 40,
  },
  ringContainer: {
    position: "absolute",
  },
  avatarInner: {
    zIndex: 2,
  },
  infoArea: {
    alignItems: "center",
    gap: 6,
    marginBottom: 32,
  },
  messageText: {
    color: "white",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  participantName: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 16,
    fontWeight: "500",
    textAlign: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.colors.primary,
  },
  supportingText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  footer: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 60 : 40,
  },
  brandText: {
    color: "rgba(255,255,255,0.1)",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
});
