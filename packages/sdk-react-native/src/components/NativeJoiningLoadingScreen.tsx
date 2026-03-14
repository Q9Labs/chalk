import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";

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

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Connecting</Text>
        <Text style={styles.title}>{displayName || "Guest"}</Text>
        <Text style={styles.body}>{message}</Text>
        <ActivityIndicator color={Theme.colors.primary} size="large" />
        {activeSupportingMessage ? <Text style={styles.supporting}>{activeSupportingMessage}</Text> : null}
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
    padding: Theme.spacing["2xl"],
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius["2xl"],
    backgroundColor: Theme.colors.card,
    padding: Theme.spacing["2xl"],
    alignItems: "center",
    gap: Theme.spacing.lg,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
    textAlign: "center",
  },
  body: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
  supporting: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
});
