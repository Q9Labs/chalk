import type { ChatAttachment } from "@q9labsai/chalk-client";
import { useEffect, useRef, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Image, Pressable, StyleSheet, View } from "react-native";
import Animated, { ReduceMotion, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { useBackHandler } from "../../frame/back-handler";
import { useDeviceLayout } from "../../frame/device-layout";
import { Portal } from "../../frame/portal";
import { Icon, type IconName } from "../../icons/Icon";
import { usePressAnimation } from "../../motion/press";
import { announce } from "../../primitives/announce";
import { ChalkText } from "../../primitives/ChalkText";
import { durations, easings, fontFamilies, viewer } from "../../theme/tokens";
import { useAttachmentSource, useDownload } from "./attachments";

export type ViewedPhotos = {
  readonly photos: readonly ChatAttachment[];
  readonly index: number;
  /** "You" or the sender's name, then the time: the viewer's second line. */
  readonly from: string;
};

type PhotoViewerProps = {
  readonly viewing: ViewedPhotos;
  readonly onChange: (index: number) => void;
  readonly onClose: () => void;
};

/**
 * The photo viewer (`.lbw`): dark in both themes, above the sheets. The name, sender and place in
 * the set sit at the top with Download and Close; Previous and Next sit at the bottom.
 */
export function PhotoViewer({ viewing, onChange, onClose }: PhotoViewerProps): React.JSX.Element | null {
  const layout = useDeviceLayout();
  const download = useDownload();
  const closeRef = useRef<View>(null);
  const { photos, index, from } = viewing;
  const photo = photos[index] ?? photos[0];
  const count = photos.length;
  useBackHandler(true, onClose);
  useEffect(() => {
    const node = closeRef.current && findNodeHandle(closeRef.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);
  const go = (step: number) => {
    const next = (index + step + count) % count;
    onChange(next);
    announce(`Image ${next + 1} of ${count}`);
  };
  if (!photo) return null;
  return (
    <Portal layer="menus">
      <Animated.View accessibilityLabel="Image viewer" accessibilityViewIsModal entering={fadeIn} exiting={fadeOut} onAccessibilityEscape={onClose} style={[StyleSheet.absoluteFill, styles.root]} testID="chat.viewer">
        <View style={[styles.top, { paddingTop: Math.max(52, layout.insets.top), paddingLeft: 16 + layout.insets.left, paddingRight: 8 + layout.insets.right }]}>
          <View style={styles.title}>
            <ChalkText color={viewer.text} numberOfLines={1} variant="bodyStrong">
              {photo.fileName}
            </ChalkText>
            <ChalkText color={viewer.textMuted} style={styles.detail} variant="label">
              {count > 1 ? `${from} · ${index + 1} of ${count}` : from}
            </ChalkText>
          </View>
          <ViewerButton icon="dl" label={`Download ${photo.fileName}`} onPress={() => download(photo)} testID="chat.viewer.download" />
          <ViewerButton icon="x" label="Close" buttonRef={closeRef} onPress={onClose} testID="chat.viewer.close" />
        </View>
        <Pressable accessible={false} onPress={onClose} style={styles.stage}>
          <Photo attachment={photo} />
          {count > 1 ? (
            <View style={styles.arrows}>
              <ViewerButton icon="left" label="Previous image" onPress={() => go(-1)} testID="chat.viewer.previous" />
              <ViewerButton icon="right" label="Next image" onPress={() => go(1)} testID="chat.viewer.next" />
            </View>
          ) : null}
        </Pressable>
      </Animated.View>
    </Portal>
  );
}

function Photo({ attachment }: { readonly attachment: ChatAttachment }): React.JSX.Element {
  const source = useAttachmentSource(attachment);
  return (
    <View pointerEvents="none" style={styles.photoBox}>
      {source.state === "ready" ? <Image accessibilityLabel={attachment.fileName} resizeMode="contain" source={{ uri: source.uri }} style={styles.photo} /> : <Icon color={viewer.textMuted} name="img" size={24} />}
    </View>
  );
}

type ViewerButtonProps = {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly testID: string;
  readonly buttonRef?: RefObject<View | null>;
};

/** `.lbb` on the phone: 44 pt, a faint white disc that brightens while pressed. */
function ViewerButton({ icon, label, onPress, testID, buttonRef }: ViewerButtonProps): React.JSX.Element {
  const press = usePressAnimation("round");
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={buttonRef} testID={testID}>
      {({ pressed }) => (
        <Animated.View style={[styles.button, { backgroundColor: pressed ? viewer.buttonPressed : viewer.button }, press.scaleStyle]}>
          <Icon color={viewer.text} name={icon} size={20} />
        </Animated.View>
      )}
    </Pressable>
  );
}

// `.lbw`: opacity over 180 ms, ease-out.
const fade = { duration: durations.menu, easing: easings.easeOut, reduceMotion: ReduceMotion.System } as const;
const fadeIn: EntryExitAnimationFunction = () => {
  "worklet";
  return { initialValues: { opacity: 0 }, animations: { opacity: withTiming(1, fade) } };
};
const fadeOut: EntryExitAnimationFunction = () => {
  "worklet";
  return { initialValues: { opacity: 1 }, animations: { opacity: withTiming(0, fade) } };
};

const styles = StyleSheet.create({
  root: { backgroundColor: viewer.backdrop },
  top: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
  title: { flex: 1, minWidth: 0 },
  detail: { fontFamily: fontFamilies[400] },
  stage: { flex: 1 },
  // `.phone .lbs img`: the full width, 108 pt kept free under it for the arrows.
  photoBox: { position: "absolute", top: 0, left: 0, right: 0, bottom: 108, alignItems: "center", justifyContent: "center" },
  photo: { width: "100%", height: "100%" },
  arrows: { position: "absolute", left: 0, right: 0, bottom: 40, flexDirection: "row", justifyContent: "center", gap: 32 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
});
