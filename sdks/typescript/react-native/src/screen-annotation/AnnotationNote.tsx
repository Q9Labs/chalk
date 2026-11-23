import { useState } from "react";
import { Modal, StyleSheet, TextInput, View } from "react-native";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { corners, space } from "../theme/tokens";
import { boundedNote } from "./model";
import { ToolButton } from "./ScreenAnnotationToolbar";

export function AnnotationNote({ onClose, onSave }: { readonly onClose: () => void; readonly onSave: (text: string, note: boolean) => void }): React.JSX.Element {
  const { colors } = useTheme();
  const [body, setBody] = useState("");
  const [note, setNote] = useState(false);
  const text = boundedNote(body);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={[styles.panel, { backgroundColor: colors.popover, borderColor: colors.lineStrong }]}>
          <ChalkText>Add text</ChalkText>
          <TextInput autoFocus multiline accessibilityLabel="Annotation text" maxLength={512} value={body} onChangeText={setBody} style={[styles.field, { backgroundColor: colors.raised, color: colors.text }]} />
          <View style={styles.actions}>
            <ToolButton label="Note background" selected={note} onPress={() => setNote(!note)} />
            <ToolButton label="Cancel" onPress={onClose} />
            {text ? <ToolButton label="Add text" selected onPress={() => onSave(text, note)} /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: "center", alignItems: "center" },
  panel: { width: "88%", maxWidth: 440, borderWidth: 1, borderRadius: corners["2xl"], padding: space[4], gap: space["2-5"] },
  field: { minHeight: 70, padding: space["2-5"], borderRadius: corners.lg },
  actions: { flexDirection: "row", gap: space[1] },
});
