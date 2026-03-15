import { memo } from "react";
import { Pressable, StyleSheet, Text, View, Modal, TouchableWithoutFeedback } from "react-native";
import { Theme } from "../ui/theme";

export interface NativeReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

function NativeReactionPickerBase({ isOpen, onClose, onSelect }: NativeReactionPickerProps): React.JSX.Element {
  return (
    <Modal animationType="fade" transparent={true} visible={isOpen} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.picker}>
              {DEFAULT_REACTIONS.map((emoji) => (
                <Pressable
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
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "transparent",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 110, // Position above the dock
  },
  picker: {
    flexDirection: "row",
    backgroundColor: Theme.colors.card,
    borderRadius: 32,
    padding: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  emojiButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  emojiButtonPressed: {
    backgroundColor: "rgba(255,255,255,0.1)",
    transform: [{ scale: 0.92 }],
  },
  emojiText: {
    fontSize: 24,
  },
});

export const NativeReactionPicker = memo(NativeReactionPickerBase);
