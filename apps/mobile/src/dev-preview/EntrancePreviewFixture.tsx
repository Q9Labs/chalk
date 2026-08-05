import type { EntranceSettings } from "@q9labsai/chalk-react-native";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

export interface EntrancePreviewFixtureProps {
  readonly spaceName: string;
  readonly defaultDisplayName?: string;
  readonly defaults?: { readonly microphone?: boolean; readonly camera?: boolean };
  readonly error?: string;
  readonly joining?: boolean;
  readonly onCancel?: () => void;
  readonly onJoin: (settings: EntranceSettings) => void | Promise<void>;
}

/**
 * A deterministic visual twin of the public Entrance contract.
 *
 * The SDK Entrance intentionally owns real camera preview permissions. The
 * development gallery must remain inspectable on a simulator and in CI, so
 * this fixture renders the same settings boundary without importing a media
 * implementation or asking the operating system for device access.
 */
export function EntrancePreviewFixture({ spaceName, defaultDisplayName = "", defaults, error, joining = false, onCancel, onJoin }: EntrancePreviewFixtureProps): React.JSX.Element {
  const displayName = defaultDisplayName;
  const microphone = defaults?.microphone ?? true;
  const camera = defaults?.camera ?? true;

  return (
    <View style={styles.screen} testID="dev-preview-entrance">
      <View style={styles.preview}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(displayName)}</Text>
        </View>
        <Text style={styles.previewLabel}>Preview fixture · no device access</Text>
        {onCancel ? (
          <Pressable accessibilityLabel="Cancel and leave Entrance" accessibilityRole="button" onPress={onCancel} style={styles.cancelButton}>
            <Text style={styles.cancelButtonText}>Back</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.sheet}>
        <Text style={styles.spaceName}>{spaceName}</Text>
        <TextInput accessibilityLabel="Your name" editable={false} style={styles.nameInput} value={displayName} />
        <View style={styles.mediaRow}>
          <Text style={styles.mediaState}>Microphone: {microphone ? "On" : "Off"}</Text>
          <Text style={styles.mediaState}>Camera: {camera ? "On" : "Off"}</Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable accessibilityLabel="Enter Space" accessibilityRole="button" accessibilityState={{ disabled: joining }} disabled={joining} onPress={() => void onJoin({ camera, displayName, microphone })} style={[styles.joinButton, joining && styles.joinButtonDisabled]}>
          <Text style={styles.joinButtonText}>{joining ? "Entering…" : "Enter Space"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function initials(displayName: string): string {
  const letters = displayName
    .trim()
    .split(/\s+/u)
    .map((part) => part[0])
    .filter((letter): letter is string => Boolean(letter))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return letters || "?";
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 16, justifyContent: "space-between", padding: 20 },
  preview: { alignItems: "center", backgroundColor: "#E8EEF0", borderRadius: 28, flex: 1, justifyContent: "center", minHeight: 220, padding: 20 },
  avatar: { alignItems: "center", backgroundColor: "#315F72", borderRadius: 72, height: 144, justifyContent: "center", width: 144 },
  avatarText: { color: "#FFFFFF", fontSize: 46, fontWeight: "800" },
  previewLabel: { color: "#555B65", fontSize: 12, marginTop: 14 },
  cancelButton: { alignSelf: "flex-start", backgroundColor: "#FFFFFF", borderColor: "#DEDDD7", borderRadius: 10, borderWidth: 1, left: 16, paddingHorizontal: 12, paddingVertical: 8, position: "absolute", top: 16 },
  cancelButtonText: { color: "#0C0E12", fontWeight: "700" },
  sheet: { backgroundColor: "#FFFFFF", borderColor: "#DEDDD7", borderRadius: 22, borderWidth: 1, gap: 14, padding: 18 },
  spaceName: { color: "#0C0E12", fontSize: 20, fontWeight: "800", textAlign: "center" },
  nameInput: { backgroundColor: "#FBFAF7", borderColor: "#DEDDD7", borderRadius: 12, borderWidth: 1, color: "#0C0E12", minHeight: 48, paddingHorizontal: 14 },
  mediaRow: { flexDirection: "row", justifyContent: "space-between" },
  mediaState: { color: "#555B65", fontSize: 13, fontWeight: "700" },
  error: { color: "#B42318", fontSize: 13, fontWeight: "700", textAlign: "center" },
  joinButton: { alignItems: "center", backgroundColor: "#315F72", borderRadius: 12, justifyContent: "center", minHeight: 50 },
  joinButtonDisabled: { opacity: 0.6 },
  joinButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
});
