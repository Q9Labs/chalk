import { memo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Theme } from "../ui/theme";

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

export const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

function ReactionPickerBase({ isOpen, onClose, onSelect }: ReactionPickerProps): React.JSX.Element {
  return (
    <Modal animationType="fade" transparent={true} visible={isOpen} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close Reactions" onPress={onClose} style={styles.backdrop} />
        <View style={styles.picker}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              Reactions
            </Text>
            <Pressable accessibilityLabel="Close Reactions" accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          {DEFAULT_REACTIONS.map((emoji) => (
            <Pressable
              accessibilityLabel={`Send ${emoji} reaction`}
              accessibilityRole="button"
              key={emoji}
              onPress={() => {
                onSelect(emoji);
                onClose();
              }}
              style={({ pressed }) => [styles.emojiButton, pressed && styles.emojiButtonPressed]}
            >
              <Text style={styles.emojiText}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Theme.colors.darkOverlay30,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 100,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Theme.colors.darkOverlay30,
  },
  picker: {
    flexDirection: "column",
    backgroundColor: Theme.colors.insetSurface,
    borderRadius: 28,
    padding: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay08,
    shadowColor: Theme.colors.darkCanvas,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", minHeight: 46, paddingHorizontal: 8, width: "100%" },
  title: { color: Theme.colors.foreground, fontSize: 16, fontWeight: "700" },
  closeButton: { alignItems: "center", borderColor: Theme.colors.border, borderRadius: Theme.radius.full, borderWidth: 1, height: 36, justifyContent: "center", width: 36 },
  closeText: { color: Theme.colors.foreground, fontSize: 23, fontWeight: "400", lineHeight: 24 },
  emojiButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiButtonPressed: {
    backgroundColor: Theme.colors.whiteOverlay12,
    transform: [{ scale: 0.88 }],
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.96 }],
  },
  emojiText: {
    fontSize: 26,
  },
});

export const ReactionPicker = memo(ReactionPickerBase);
