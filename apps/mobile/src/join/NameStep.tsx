import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { ChalkText, PillButton, useTheme } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useState } from "react";
import { BackHandler, KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { TextField } from "../home/TextField";

type NameStepProps = {
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
};

/** T2: shown only when the app has no name yet. Join call stays off until there is one; the card rides above the keyboard. */
export function NameStep({ onSubmit, onCancel }: NameStepProps): React.JSX.Element {
  const { colors } = useTheme();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed) onSubmit(trimmed);
  };
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => subscription.remove();
  }, [onCancel]);

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: colors.canvas }]} testID="join.name-step">
      <View style={styles.notice}>
        <PrivacyNotice />
      </View>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <ChalkText variant="button">Your name</ChalkText>
        <TextField accessibilityLabel="Your name" autoComplete="name" autoFocus enterKeyHint="go" maxLength={40} onChangeText={setName} onSubmitEditing={submit} size="card" testID="join.name" textContentType="name" value={name} />
        <View style={styles.submit}>
          <PillButton disabled={!trimmed} label="Join call" onPress={submit} size="card" testID="join.name.submit" variant="primary" />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
  notice: { width: "100%", maxWidth: 440, paddingHorizontal: 16 },
  card: { width: 300, padding: 20, gap: 8, borderWidth: 1, borderRadius: 16 },
  submit: { marginTop: 6 },
});
