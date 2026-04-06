import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import type { NativeJoiningLoadingScreenProps } from "./NativeJoiningLoadingScreen";

export function NativeJoiningLoadingScreenAndroid({ displayName, message = "Joining room...", supportingMessages = [] }: NativeJoiningLoadingScreenProps): React.JSX.Element {
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
    Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim, rotateAnim]);

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  const activeSupportingMessage = supportingMessages[messageIndex] ?? "Initializing...";

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        <View style={styles.heroWrapper}>
          <Animated.View style={[styles.ringContainer, { transform: [{ rotate: spin }] }]}>
            <Svg height="160" width="160" viewBox="0 0 100 100">
              <Circle cx="50" cy="50" r="48" stroke="rgba(255,255,255,0.04)" strokeWidth="1.5" fill="none" />
              <Circle cx="50" cy="50" r="48" stroke={Theme.colors.primary} strokeWidth="2" strokeDasharray="50 210" strokeLinecap="round" fill="none" />
            </Svg>
          </Animated.View>

          <View style={styles.avatarInner}>
            <NativeFaceAvatar name={displayName} size={100} />
          </View>
        </View>

        <View style={styles.infoArea}>
          <Text style={styles.messageText}>{message}</Text>
          <Text style={styles.participantName}>{displayName}</Text>
        </View>

        <View style={styles.statusBadge}>
          <View style={styles.dot} />
          <Text style={styles.supportingText}>{activeSupportingMessage}</Text>
        </View>
      </Animated.View>

      <View style={styles.footer}>
        <Text style={styles.brandText}>chalk</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 40,
  },
  heroWrapper: {
    width: 160,
    height: 160,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 36,
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
    color: Theme.colors.foreground,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  participantName: {
    color: Theme.colors.mutedForeground,
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Theme.colors.primary,
  },
  supportingText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  footer: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 50 : 36,
  },
  brandText: {
    color: "rgba(255,255,255,0.08)",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
});
