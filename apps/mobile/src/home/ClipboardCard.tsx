import { ChalkText, fontFamilies, Icon, IconButton, PillButton, useTheme } from "@q9labsai/chalk-react-native/ui";
import { addClipboardListener, getStringAsync, hasUrlAsync } from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, Keyframe } from "react-native-reanimated";
import { displayLink, parseSpaceLink, type SpaceRoute } from "../lib/spaces";
import { PasteButton } from "./PasteButton";

/**
 * What the clipboard offers. iOS can only tell that a link is there without reading it (reading
 * would show "Allow Paste"), so the person pastes it with the system button. Android reads it.
 */
type ClipboardOffer = { readonly kind: "ios-link" } | { readonly kind: "android-link"; readonly text: string; readonly route: SpaceRoute };

/** `@keyframes pin` over 200 ms on `--ease`. */
const pinIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 4 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: Easing.bezier(0.16, 1, 0.3, 1) },
}).duration(200);

/**
 * K6: a link on the clipboard. Dismissing it hides the card until the clipboard changes; on
 * Android the dismissed link is remembered, since iOS can't say which link it was.
 */
export function useClipboardOffer(): { readonly offer: ClipboardOffer | null; readonly dismiss: () => void } {
  const [offer, setOffer] = useState<ClipboardOffer | null>(null);
  const [dismissed, setDismissed] = useState<string | true | null>(null);

  // A clipboard the OS won't let us inspect offers nothing, so a failed read shows no card.
  const check = useCallback(async () => {
    if (Platform.OS === "ios") {
      setOffer(
        await hasUrlAsync().then(
          (has) => (has ? { kind: "ios-link" } : null),
          () => null,
        ),
      );
      return;
    }
    const text = await getStringAsync().then(
      (value) => value.trim(),
      () => "",
    );
    const route = parseSpaceLink(text);
    setOffer(route ? { kind: "android-link", text, route } : null);
  }, []);

  useEffect(() => {
    void check();
    const active = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    const changed = addClipboardListener(() => {
      setDismissed((current) => (current === true ? null : current));
      void check();
    });
    return () => {
      active.remove();
      changed.remove();
    };
  }, [check]);

  const hidden = offer === null || dismissed === true || (offer.kind === "android-link" && dismissed === offer.text);
  const dismiss = useCallback(() => setDismissed(offer?.kind === "android-link" ? offer.text : true), [offer]);
  return { offer: hidden ? null : offer, dismiss };
}

type ClipboardCardProps = {
  readonly offer: ClipboardOffer;
  readonly onDismiss: () => void;
  readonly onJoin: (route: SpaceRoute) => void;
  readonly onNotALink: () => void;
};

/** `.clipc`: the clipboard card above Start a call. */
export function ClipboardCard({ offer, onDismiss, onJoin, onNotALink }: ClipboardCardProps): React.JSX.Element {
  const { colors } = useTheme();
  const paste = (text: string) => {
    onDismiss();
    const route = parseSpaceLink(text);
    if (route) onJoin(route);
    else onNotALink();
  };

  return (
    <Animated.View entering={pinIn} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]} testID="home.clipboard">
      <View style={styles.icon}>
        <Icon color={colors.textSoft} name="link" size={20} />
      </View>
      {offer.kind === "ios-link" ? (
        <ChalkText style={styles.text} tone="textSoft">
          You copied a link. Paste it to join the call.
        </ChalkText>
      ) : (
        <ChalkText style={styles.text} tone="textSoft">
          Join <Text style={[styles.link, { color: colors.text }]}>{displayLink(offer.text)}</Text> from your clipboard?
        </ChalkText>
      )}
      {offer.kind === "ios-link" ? (
        <PasteButton onPaste={paste} testID="home.clipboard.paste" />
      ) : (
        <PillButton
          label="Join"
          onPress={() => {
            onDismiss();
            onJoin(offer.route);
          }}
          size="inline"
          testID="home.clipboard.join"
          variant="primary"
        />
      )}
      <IconButton accessibilityLabel="Dismiss" icon="x" onPress={onDismiss} size={36} testID="home.clipboard.dismiss" tone="ghost" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 60, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 4, marginBottom: 2, borderRadius: 16, borderWidth: 1 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0, lineHeight: 14 * 1.35 },
  link: { fontFamily: fontFamilies[600] },
});
