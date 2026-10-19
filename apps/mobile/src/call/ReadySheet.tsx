import { BottomSheet, ChalkText, CopyButton, IconButton, PillButton, useTheme } from "@q9labsai/chalk-react-native/ui";
import { setStringAsync } from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { shareLink } from "../lib/share";
import { displayLink } from "../lib/spaces";
import { QrCode } from "./QrCode";

type ReadySheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly link: string;
};

/** "Your call is ready": shown once after Start a call, with the link to copy, show as a QR code, or share. */
export function ReadySheet({ open, onClose, link }: ReadySheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const [showQr, setShowQr] = useState(false);

  return (
    <BottomSheet accessibilityLabel="Your call is ready" inset={20} onClose={onClose} open={open} testID="sheet.ready">
      <View style={styles.head}>
        <ChalkText accessibilityRole="header" variant="cardTitle">
          Your call is ready
        </ChalkText>
        <IconButton accessibilityLabel="Close" icon="x" onPress={onClose} size={44} testID="ready.close" tone="ghost" />
      </View>
      <ChalkText style={styles.lead} tone="textMuted" variant="meta">
        Share this link with people you want in the call
      </ChalkText>
      <View style={[styles.linkRow, { backgroundColor: colors.raised }]}>
        <ChalkText numberOfLines={1} style={styles.link} variant="bodyMedium">
          {displayLink(link)}
        </ChalkText>
        <View style={styles.linkButtons}>
          <IconButton accessibilityLabel={showQr ? "Hide QR code" : "Show QR code"} expanded={showQr} icon="qr" onPress={() => setShowQr((shown) => !shown)} size={36} testID="ready.qr" tone="ghost" />
          <CopyButton accessibilityLabel="Copy link" announcement="Link copied" onCopy={() => setStringAsync(link).then(() => undefined)} testID="ready.copy" />
        </View>
      </View>
      {showQr ? (
        <Animated.View entering={FadeIn.duration(200)} style={styles.qr} testID="ready.qr-code">
          <QrCode value={link} />
          <ChalkText style={styles.qrText} tone="textSoft" variant="meta">
            Scan with a phone camera to join this call.
          </ChalkText>
        </Animated.View>
      ) : null}
      <View style={styles.share}>
        <PillButton icon="iosShare" label="Share link" onPress={() => shareLink(link)} size="wide" testID="ready.share" variant="primary" />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: -6, marginBottom: 2 },
  lead: { marginRight: 4 },
  linkRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12, height: 44, paddingLeft: 14, paddingRight: 4, borderRadius: 999 },
  link: { flex: 1, minWidth: 0 },
  linkButtons: { flexDirection: "row", gap: 2 },
  qr: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12 },
  qrText: { flex: 1 },
  share: { marginTop: 12 },
});
