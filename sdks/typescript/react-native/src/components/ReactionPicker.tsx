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
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={isOpen}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close Reactions" onPress={onClose} style={styles.backdrop} />
        <View style={styles.picker}>
          <View style={styles.header}>
            <Text style={styles.title}>Reactions</Text>
            <Pressable accessibilityLabel="Close Reactions" accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          <View style={styles.reactionRow}>
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { alignItems: "center", flex: 1, justifyContent: "flex-end", paddingBottom: 110, paddingHorizontal: Theme.spacing.lg },
  backdrop: { backgroundColor: "rgba(12,14,18,0.22)", bottom: 94, left: 0, position: "absolute", right: 0, top: 0 },
  picker: { backgroundColor: Theme.colors.surface, borderColor: Theme.colors.line, borderRadius: Theme.radius.lg, elevation: 8, padding: Theme.spacing.sm, shadowColor: Theme.colors.ink, shadowOffset: { height: 6, width: 0 }, shadowOpacity: 0.14, shadowRadius: 18, width: "100%" },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", minHeight: 46, paddingHorizontal: Theme.spacing.sm },
  title: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700" },
  closeButton: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.full, borderWidth: 1, height: 36, justifyContent: "center", width: 36 },
  closeText: { color: Theme.colors.ink, fontSize: 23, fontWeight: "400", lineHeight: 24 },
  reactionRow: { flexDirection: "row", justifyContent: "space-between", padding: Theme.spacing.xs },
  emojiButton: { alignItems: "center", borderRadius: Theme.radius.md, height: 52, justifyContent: "center", width: 52 },
  emojiButtonPressed: { backgroundColor: Theme.colors.washBlue, transform: [{ scale: 0.88 }] },
  emojiText: { fontSize: 28 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
});

export const ReactionPicker = memo(ReactionPickerBase);
