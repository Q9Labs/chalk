import AsyncStorage from "@react-native-async-storage/async-storage";
import { ChalkText, IconButton, useTheme, useToasts } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { PRIVACY_NOTICE_DISMISSAL_KEY, PRIVACY_NOTICE_LINK_TEXT, PRIVACY_NOTICE_TEXT, usePrivacyUpdatePending } from "../../../shared/privacy-update";

export function PrivacyNotice(): React.JSX.Element | null {
  const pending = usePrivacyUpdatePending();
  const [dismissed, setDismissed] = useState(false);
  const { colors } = useTheme();
  const toasts = useToasts();
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(PRIVACY_NOTICE_DISMISSAL_KEY).then(
      (value) => {
        if (active && value === "dismissed") setDismissed(true);
      },
      () => {
        /* Disabled storage leaves the notice available for this visit. */
      },
    );
    return () => {
      active = false;
    };
  }, []);
  function dismiss() {
    setDismissed(true);
    void AsyncStorage.setItem(PRIVACY_NOTICE_DISMISSAL_KEY, "dismissed").catch(() => {
      // Dismissal still applies for this visit if storage is unavailable.
    });
  }
  if (!pending || dismissed) return null;
  return (
    <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.line }]} testID="privacy.notice">
      <ChalkText style={styles.text} variant="meta">
        {PRIVACY_NOTICE_TEXT}{" "}
        <ChalkText
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL("https://chalkmeet.com/privacy").catch(() => toasts.show({ kind: "error", message: "Couldn’t open the Privacy Policy. Try again." }));
          }}
          style={styles.link}
          variant="meta"
          testID="privacy.notice.link"
        >
          {PRIVACY_NOTICE_LINK_TEXT}
        </ChalkText>
      </ChalkText>
      <IconButton accessibilityLabel="Dismiss Privacy Policy notice" icon="x" onPress={dismiss} testID="privacy.notice.dismiss" tone="ghost" />
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, padding: 8, marginVertical: 8 },
  text: { flex: 1 },
  link: { textDecorationLine: "underline" },
});
