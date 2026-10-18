import { setStringAsync } from "expo-clipboard";
import type { RefObject } from "react";
import { Platform, Pressable, Share, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useDeviceLayout } from "../frame/device-layout";
import { usePreferences } from "../frame/preferences";
import { Icon } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { BottomSheet } from "../primitives/BottomSheet";
import { ChalkText } from "../primitives/ChalkText";
import { CopyButton } from "../primitives/CopyButton";
import { IconButton } from "../primitives/IconButton";
import { MenuSection } from "../primitives/Menu";
import { SegmentedControl } from "../primitives/SegmentedControl";
import { Switch } from "../primitives/Switch";
import { useTheme } from "../theme/theme";
import { sizes, type ColorScheme } from "../theme/tokens";
import { QrCode } from "./QrCode";

export type CallDetailsSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly callName: string;
  /** The call's link; without it the Share section is left out. */
  readonly inviteLink?: string;
  readonly returnFocusRef?: RefObject<View | null>;
};

const DETAILS_TOP = 58;

const SCHEMES = [
  { value: "dark", label: "Dark", testID: "details.appearance.dark" },
  { value: "light", label: "Light", testID: "details.appearance.light" },
] as const;

/**
 * Call details (`#info`), opened from the call's name: the link with copy, share and a QR code,
 * then the appearance and sound choices.
 */
export function CallDetailsSheet({ open, onClose, callName, inviteLink, returnFocusRef }: CallDetailsSheetProps): React.JSX.Element {
  const preferences = usePreferences();
  const layout = useDeviceLayout();
  // `.dev .infop` keeps its top 58 pt under the safe area on a phone too, so the sheet runs from there to the bottom edge.
  const heightRatio = (layout.height - layout.insets.top - DETAILS_TOP) / layout.height;
  return (
    <BottomSheet accessibilityLabel={callName} heightRatio={heightRatio} inset={14} onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.details" variant="popover">
      <View style={styles.heading}>
        <ChalkText accessibilityRole="header" numberOfLines={1} style={styles.title} variant="cardTitle">
          {callName}
        </ChalkText>
        <IconButton accessibilityLabel="Close" icon="x" onPress={onClose} size={36} testID="details.close" tone="ghost" />
      </View>
      {inviteLink ? <ShareSection link={inviteLink} /> : null}
      <Section first={!inviteLink}>
        <MenuRow end={<SegmentedControl<ColorScheme> accessibilityLabel="Appearance" onChange={preferences.setColorScheme} options={SCHEMES} size="compact" testID="details.appearance" value={preferences.colorScheme} />} label="Appearance" />
        <MenuRow end={<Switch accessibilityLabel="Sounds" onValueChange={preferences.setSoundsEnabled} testID="details.sounds" value={preferences.soundsEnabled} />} label="Sounds" />
      </Section>
    </BottomSheet>
  );
}

function ShareSection({ link }: { readonly link: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Section first>
      <MenuSection label="Share" />
      <View style={[styles.link, { backgroundColor: colors.hover }]} testID="details.link">
        <ChalkText numberOfLines={1} selectable style={styles.linkText} variant="bodyMedium">
          {displayLink(link)}
        </ChalkText>
        <View style={styles.linkButtons}>
          <CopyButton accessibilityLabel="Copy link" announcement="Link copied" onCopy={() => setStringAsync(link).then(() => undefined)} testID="details.copy" />
          <ShareButton link={link} />
        </View>
      </View>
      <View style={styles.qr}>
        <QrCode size={112} value={link} />
        <ChalkText style={styles.qrText} tone="textSoft" variant="meta">
          Scan with a phone camera to join this call.
        </ChalkText>
      </View>
    </Section>
  );
}

/** The link as people read it, `chalkmeet.com/q9-team`, without the scheme or the invite token. */
export function displayLink(link: string): string {
  return link.replace(/^https?:\/\//u, "").replace(/[#?].*$/u, "");
}

/** `.cp` with the share icon: a 36 pt round button that darkens and shrinks while pressed. */
function ShareButton({ link }: { readonly link: string }): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("small");
  const share = () => {
    Share.share(Platform.OS === "ios" ? { url: link } : { message: link }).catch(() => undefined);
  };
  return (
    <Pressable accessibilityLabel="Share link" accessibilityRole="button" hitSlop={4} onPress={share} onPressIn={press.onPressIn} onPressOut={press.onPressOut} testID="details.share">
      {({ pressed }) => (
        <Animated.View style={[styles.round, pressed ? { backgroundColor: colors.pressed } : null, press.scaleStyle]}>
          <Icon color={colors.text} name="iosShare" />
        </Animated.View>
      )}
    </Pressable>
  );
}

/** `.isec`: sections after the first sit under a hairline. */
function Section({ first = false, children }: { readonly first?: boolean; readonly children: React.ReactNode }): React.JSX.Element {
  const { colors } = useTheme();
  return <View style={[styles.section, first ? null : { borderTopWidth: 1, borderTopColor: colors.line }]}>{children}</View>;
}

/** `.mi` holding its own control at the end, such as the appearance switch (`.mi.appr`). */
function MenuRow({ label, end }: { readonly label: string; readonly end: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <ChalkText numberOfLines={1} style={styles.rowLabel}>
        {label}
      </ChalkText>
      {end}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 2, paddingBottom: 4, paddingLeft: 10 },
  title: { flexShrink: 1 },
  section: { paddingTop: 4, paddingBottom: 8 },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, height: 44, marginHorizontal: 6, paddingLeft: 14, paddingRight: 4, borderRadius: 999 },
  linkText: { flexShrink: 1 },
  linkButtons: { flexDirection: "row", gap: 2 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  qr: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10, marginHorizontal: 6, marginBottom: 2 },
  qrText: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: sizes.menuRowPhone, paddingHorizontal: 10 },
  rowLabel: { flex: 1 },
});
