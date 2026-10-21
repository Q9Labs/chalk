import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { BottomSheet, ChalkText, PillButton } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useState, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import { parseSpaceLink, type SpaceRoute } from "../lib/spaces";
import { PasteButton } from "./PasteButton";
import { TextField } from "./TextField";

type JoinSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onJoin: (route: SpaceRoute) => void;
  readonly returnFocusRef: RefObject<View | null>;
};

/** "Join with a link": paste or type a call link. A link that isn't Chalk's says so under the field. */
export function JoinSheet({ open, onClose, onJoin, returnFocusRef }: JoinSheetProps): React.JSX.Element {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLink("");
    setInvalid(false);
  }, [open]);
  const change = (text: string) => {
    setLink(text);
    setInvalid(false);
  };
  const join = () => {
    const route = parseSpaceLink(link);
    if (route) onJoin(route);
    else setInvalid(true);
  };

  return (
    <BottomSheet accessibilityLabel="Join with a link" onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.join" title="Join with a link">
      <View style={styles.form}>
        <PrivacyNotice />
        <ChalkText variant="button">Call link</ChalkText>
        <View style={styles.row}>
          <TextField accessibilityLabel="Call link" autoCapitalize="none" autoComplete="off" autoCorrect={false} enterKeyHint="go" invalid={invalid} keyboardType="url" onChangeText={change} onSubmitEditing={join} placeholder="chalkmeet.com/…" size="sheet" testID="join.link" value={link} />
          <PasteButton onPaste={change} testID="join.paste" />
        </View>
        <ChalkText accessibilityLiveRegion="polite" tone={invalid ? "dangerText" : "textMuted"} variant="meta">
          {invalid ? "This isn’t a Chalk call link. Check it, then try again." : "Paste or type the link someone sent you."}
        </ChalkText>
        <View style={styles.submit}>
          <PillButton disabled={!link.trim()} label="Join call" onPress={join} size="big" testID="join.submit" variant="primary" />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8, paddingHorizontal: 4, paddingBottom: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  submit: { marginTop: 8 },
});
