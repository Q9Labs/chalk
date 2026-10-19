import { BottomSheet, ChalkText, PillButton, SegmentedControl, SheetGroup, SheetRow, Switch, type ColorScheme } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useState, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import type { StoredCallPreferences } from "../preferences/call-preferences";
import { TextField } from "./TextField";

const SCHEMES = [
  { value: "dark", label: "Dark", testID: "you.appearance.dark" },
  { value: "light", label: "Light", testID: "you.appearance.light" },
] as const;

type YouSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly name: string | null;
  readonly onSaveName: (name: string) => void;
  readonly preferences: StoredCallPreferences;
  readonly returnFocusRef: RefObject<View | null>;
};

/** "Your name and appearance": the name others see, Dark or Light, and call sounds. */
export function YouSheet({ open, onClose, name, onSaveName, preferences, returnFocusRef }: YouSheetProps): React.JSX.Element {
  const [draft, setDraft] = useState(name ?? "");
  useEffect(() => {
    if (open) setDraft(name ?? "");
  }, [name, open]);
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== name;
  const save = () => {
    if (canSave) onSaveName(trimmed);
  };

  return (
    <BottomSheet accessibilityLabel="Your name and appearance" onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.you" title="Your name and appearance">
      <View style={styles.form}>
        <ChalkText variant="button">Your name</ChalkText>
        <View style={styles.row}>
          <TextField
            accessibilityHint="People in a call see this name."
            accessibilityLabel="Your name"
            autoComplete="name"
            enterKeyHint="done"
            maxLength={40}
            onChangeText={setDraft}
            onSubmitEditing={save}
            placeholder="For example, Sam"
            size="sheet"
            testID="you.name"
            textContentType="name"
            value={draft}
          />
          <PillButton disabled={!canSave} label="Save" onPress={save} size="field" testID="you.save" variant="primary" />
        </View>
        <ChalkText tone="textMuted" variant="meta">
          People in a call see this name.
        </ChalkText>
      </View>
      <SheetGroup>
        <SheetRow end={<SegmentedControl<ColorScheme> accessibilityLabel="Appearance" onChange={preferences.setColorScheme} options={SCHEMES} testID="you.appearance" value={preferences.colorScheme} />} label="Appearance" />
        <SheetRow end={<Switch accessibilityLabel="Sounds" onValueChange={preferences.setSoundsEnabled} testID="you.sounds" value={preferences.soundsEnabled} />} label="Sounds" />
      </SheetGroup>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8, paddingHorizontal: 4, paddingBottom: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
