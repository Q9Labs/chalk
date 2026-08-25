import { Theme } from "@q9labsai/chalk-react-native/theme";
import { useCallback, useEffect, useState } from "react";
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { BrandMark } from "../components/BrandMark";
import type { SpaceRoute } from "../lib/spaces";

const WEB_SPACE_ORIGIN = "https://chalkmeet.com";

type ExpoGoSpaceScreenProps = {
  readonly defaultDisplayName?: string | null;
  readonly onClose: () => Promise<void>;
  readonly route: SpaceRoute;
};

type MediaPermissionState = "checking" | "granted" | "denied";

export function ExpoGoSpaceScreen({ defaultDisplayName, onClose, route }: ExpoGoSpaceScreenProps): React.JSX.Element {
  const sourceUrl = createExpoGoSpaceUrl(route, defaultDisplayName);
  const [mediaPermission, setMediaPermission] = useState<MediaPermissionState>(Platform.OS === "android" ? "checking" : "granted");

  const requestMediaPermission = useCallback(async () => {
    if (Platform.OS !== "android") {
      setMediaPermission("granted");
      return;
    }

    setMediaPermission("checking");
    const result = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);
    const granted = result[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED && result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
    setMediaPermission(granted ? "granted" : "denied");
  }, []);

  useEffect(() => {
    void requestMediaPermission();
  }, [requestMediaPermission]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View accessibilityLabel="Chalk" style={styles.wordmark}>
          <BrandMark size={28} />
          <Text style={styles.wordmarkText}>chalk</Text>
        </View>
        <Pressable accessibilityLabel="Back to home" accessibilityRole="button" onPress={() => void onClose()} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>

      {mediaPermission === "granted" ? (
        <WebView allowsInlineMediaPlayback domStorageEnabled javaScriptEnabled mediaPlaybackRequiresUserAction={false} originWhitelist={["https://*"]} setSupportMultipleWindows={false} source={{ uri: sourceUrl }} style={styles.webView} />
      ) : (
        <View style={styles.permissionPanel}>
          <Text style={styles.eyebrow}>IN-APP SPACE</Text>
          <Text style={styles.title}>{mediaPermission === "checking" ? "Preparing your camera and microphone…" : "Camera and microphone access is required."}</Text>
          {mediaPermission === "denied" ? (
            <Pressable accessibilityLabel="Allow camera and microphone" accessibilityRole="button" onPress={() => void requestMediaPermission()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
              <Text style={styles.primaryButtonText}>Allow camera and microphone</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

export function createExpoGoSpaceUrl(route: SpaceRoute, defaultDisplayName?: string | null): string {
  const url = new URL("/space", WEB_SPACE_ORIGIN);
  const displayName = defaultDisplayName?.trim();
  if (displayName) url.searchParams.set("name", displayName);
  if (route.spaceInviteToken) url.hash = new URLSearchParams({ spaceInviteToken: route.spaceInviteToken }).toString();
  return url.toString();
}

const styles = StyleSheet.create({
  container: { backgroundColor: Theme.colors.background, flex: 1 },
  header: { alignItems: "center", borderBottomColor: Theme.colors.border, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 56, paddingHorizontal: Theme.spacing.lg },
  wordmark: { alignItems: "center", flexDirection: "row", gap: 7 },
  wordmarkText: { color: Theme.colors.ink, fontSize: 20, fontWeight: "800", letterSpacing: -0.7 },
  closeButton: { alignItems: "center", justifyContent: "center", minHeight: 44, paddingHorizontal: Theme.spacing.sm },
  closeButtonText: { color: Theme.colors.ink, fontSize: 15, fontWeight: "700" },
  webView: { backgroundColor: Theme.colors.background, flex: 1 },
  permissionPanel: { flex: 1, justifyContent: "center", paddingHorizontal: Theme.spacing["2xl"] },
  eyebrow: { color: Theme.colors.chalkPink, fontSize: 12, fontWeight: "800", letterSpacing: 1.2, marginBottom: Theme.spacing.md },
  title: { color: Theme.colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, lineHeight: 37 },
  primaryButton: { alignItems: "center", backgroundColor: Theme.colors.primary, borderRadius: Theme.radius.md, justifyContent: "center", marginTop: Theme.spacing["2xl"], minHeight: 56 },
  primaryButtonText: { color: Theme.colors.primaryForeground, fontSize: 16, fontWeight: "800" },
  pressed: { opacity: 0.75 },
});
