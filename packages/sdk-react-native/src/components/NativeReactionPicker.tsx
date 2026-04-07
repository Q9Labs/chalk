import { memo } from "react";
import { Pressable, StyleSheet, Text, View, Modal, TouchableWithoutFeedback } from "react-native";

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
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 100,
  },
  picker: {
    flexDirection: "row",
    backgroundColor: "#0c0c0e",
    borderRadius: 28,
    padding: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  emojiButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiButtonPressed: {
    backgroundColor: "rgba(255,255,255,0.12)",
    transform: [{ scale: 0.88 }],
  },
  emojiText: {
    fontSize: 26,
  },
});

export const NativeReactionPicker = memo(NativeReactionPickerBase);
