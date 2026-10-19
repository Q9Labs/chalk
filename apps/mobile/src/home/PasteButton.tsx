import { PillButton, useTheme } from "@q9labsai/chalk-react-native/ui";
import { ClipboardPasteButton, getStringAsync, isPasteButtonAvailable } from "expo-clipboard";
import { Platform, StyleSheet } from "react-native";

type PasteButtonProps = {
  readonly onPaste: (text: string) => void;
  readonly testID?: string;
};

/**
 * Paste (`.pastebtn`). On iOS it's the system Paste button, so iOS never asks "Allow Paste";
 * the OS draws its label and icon. Android reads the clipboard directly.
 */
export function PasteButton({ onPaste, testID }: PasteButtonProps): React.JSX.Element {
  const { colors } = useTheme();
  if (Platform.OS === "ios" && isPasteButtonAvailable) {
    return (
      <ClipboardPasteButton
        acceptedContentTypes={["plain-text", "url"]}
        accessibilityLabel="Paste"
        backgroundColor={colors.hover}
        cornerStyle="capsule"
        displayMode="iconAndLabel"
        foregroundColor={colors.text}
        onPress={(data) => {
          if (data.type === "text") onPaste(data.text);
        }}
        style={styles.system}
        testID={testID}
      />
    );
  }
  return <PillButton icon="paste" label="Paste" onPress={() => void getStringAsync().then(onPaste)} size="lg" testID={testID} />;
}

const styles = StyleSheet.create({
  system: { width: 96, height: 40 },
});
