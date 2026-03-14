import { getParticipantColor } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import { NativeGradientSurface } from "./NativeGradientSurface";

export interface NativeJoiningLoadingScreenProps {
  displayName: string;
  message?: string;
  supportingMessages?: readonly string[];
}

export function NativeJoiningLoadingScreen({
  displayName,
  message = "Joining room...",
  supportingMessages = [],
}: NativeJoiningLoadingScreenProps): React.JSX.Element {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (supportingMessages.length <= 1) {
      return;
    }

    const intervalId = setInterval(() => {
      setMessageIndex((current) => (current + 1) % supportingMessages.length);
    }, 1400);

    return () => clearInterval(intervalId);
  }, [supportingMessages]);

  const activeSupportingMessage = supportingMessages[messageIndex] ?? null;
  const colors = useMemo(() => getParticipantColor(displayName), [displayName]);

  return (
    <View style={styles.screen}>
      <NativeGradientSurface participantId={displayName} opacity={0.14} />
      <View style={styles.content}>
        <NativeFaceAvatar name={displayName} size={140} />

        <View style={styles.textContainer}>
          <Text style={styles.title}>{displayName || "Guest"}</Text>
          <Text style={styles.body}>{message}</Text>
        </View>

        <View style={styles.loaderContainer}>
          <ActivityIndicator color={colors.primary} size="large" />
          <View style={styles.supportingContainer}>
            {activeSupportingMessage ? (
              <Text style={styles.supporting}>{activeSupportingMessage}</Text>
            ) : (
              <Text style={styles.supporting}>Please wait...</Text>
            )}
          </View>
        </View>
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
    padding: 24,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 40,
    width: "100%",
    maxWidth: 420,
  },
  textContainer: {
    alignItems: "center",
    gap: 8,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 32,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  body: {
    color: Theme.colors.mutedForeground,
    fontSize: 18,
    fontWeight: "500",
    textAlign: "center",
  },
  loaderContainer: {
    alignItems: "center",
    gap: 20,
    height: 80, // Fixed height to prevent layout shifts when text changes
  },
  supportingContainer: {
    height: 24,
    justifyContent: "center",
  },
  supporting: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
  },
});
