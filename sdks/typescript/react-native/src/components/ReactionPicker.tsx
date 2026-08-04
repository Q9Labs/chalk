import { memo } from "react";
import { Pressable, StyleSheet, Text, View, Modal, TouchableWithoutFeedback } from "react-native";

import { Theme } from "../ui/theme";

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

function ReactionPickerBase({ isOpen, onClose, onSelect }: ReactionPickerProps): React.JSX.Element {
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
    backgroundColor: Theme.colors.darkOverlay30,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 100,
  },
  picker: {
    flexDirection: "row",
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
  emojiText: {
    fontSize: 26,
  },
});

export const ReactionPicker = memo(ReactionPickerBase);
