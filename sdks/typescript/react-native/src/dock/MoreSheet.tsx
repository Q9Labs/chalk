import type { Reaction } from "@q9labsai/chalk-client";
import { setStringAsync } from "expo-clipboard";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSpaceClient } from "../context/space-client-context";
import { usePreferences } from "../frame/preferences";
import { haptics } from "../haptics/haptics";
import { useCan, useChat, useMedia, useParticipants, useRecording, useSelf } from "../hooks/space-hooks";
import { Icon } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { announce } from "../primitives/announce";
import { BottomSheet } from "../primitives/BottomSheet";
import { ChalkText } from "../primitives/ChalkText";
import { SheetGroup, SheetRow } from "../primitives/SheetGroup";
import { useToasts } from "../primitives/toast/ToastStack";
import { playSound } from "../sounds/sounds";
import { useTheme } from "../theme/theme";
import { durations, fixed } from "../theme/tokens";

export type MoreSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenPeople: () => void;
  readonly onOpenChat: () => void;
  /** The call's link; without it the sheet leaves out Copy link and Share link. */
  readonly inviteLink?: string;
  readonly returnFocusRef?: RefObject<View | null>;
};

/** The call's one reaction set, in the mockup's order, with the names screen readers say. */
const REACTIONS: readonly (readonly [Reaction, string])[] = [
  ["👍", "thumbs up"],
  ["❤️", "heart"],
  ["😂", "laughter"],
  ["😮", "surprise"],
  ["🎉", "celebration"],
  ["😢", "sadness"],
];

/**
 * More (`#more`): raise hand and reactions on top, then the call's link, recording for hosts,
 * Chat, People and switching camera. Actions that change the call close the sheet; copying keeps it open.
 */
export function MoreSheet({ open, onClose, onOpenPeople, onOpenChat, inviteLink, returnFocusRef }: MoreSheetProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const people = useParticipants().roster.length;
  const toasts = useToasts();
  const { soundsEnabled } = usePreferences();
  const canRaiseHand = useCan("raiseHand");
  const canReact = useCan("sendReaction");

  const fail = useCallback((message: string) => () => toasts.show({ kind: "error", dismissible: true, message }), [toasts]);
  const toggleHand = useCallback(() => {
    onClose();
    haptics.handRaise();
    if (self.handRaised) {
      client.participants.lowerHand().catch(fail("Couldn't lower your hand."));
      return;
    }
    playSound("hand", soundsEnabled);
    announce("You raised a hand");
    client.participants.raiseHand().catch(fail("Couldn't raise your hand."));
  }, [client, fail, onClose, self.handRaised, soundsEnabled]);
  const react = useCallback(
    (emoji: Reaction) => {
      onClose();
      client.reactions.send(emoji).catch(fail("Couldn't send your reaction."));
    },
    [client, fail, onClose],
  );

  return (
    <BottomSheet accessibilityLabel="More options" onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.more">
      {canRaiseHand || canReact ? (
        <View accessibilityLabel="Reactions" accessibilityRole="toolbar" style={styles.reactions}>
          {canRaiseHand ? <HandButton onPress={toggleHand} raised={self.handRaised} /> : null}
          {canReact ? REACTIONS.map(([emoji, name], index) => <EmojiButton emoji={emoji} key={emoji} name={name} onPress={react} testID={`more.reaction.${index}`} />) : null}
        </View>
      ) : null}
      <SheetGroup>
        {inviteLink ? <CopyLinkRow link={inviteLink} /> : null}
        {inviteLink ? <SheetRow icon="iosShare" label="Share link" onPress={() => shareLink(inviteLink)} testID="more.share" /> : null}
        <RecordingRow onDone={onClose} />
        <ChatRow onPress={onOpenChat} />
        <SheetRow end={<PeopleCount count={people} />} icon="users" label="People" onPress={onOpenPeople} testID="more.people" />
        <SwitchCameraRow onDone={onClose} />
      </SheetGroup>
    </BottomSheet>
  );
}

function shareLink(link: string): void {
  // iOS shares a URL as a link with its preview; Android takes it as the message text.
  Share.share(Platform.OS === "ios" ? { url: link } : { message: link }).catch(() => undefined);
}

/** `.hand2`: a raised hand turns the button yellow until it's lowered. */
function HandButton({ raised, onPress }: { readonly raised: boolean; readonly onPress: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("pill");
  const foreground = raised ? fixed.handText : colors.text;
  return (
    <Pressable accessibilityLabel={raised ? "Lower hand" : "Raise hand"} accessibilityRole="button" accessibilityState={{ selected: raised }} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} testID="more.hand">
      <Animated.View style={[styles.hand, { backgroundColor: raised ? fixed.hand : colors.raised }, press.scaleStyle]}>
        <Icon color={foreground} name="hand" />
        <ChalkText color={foreground} variant="bodyStrong">
          {raised ? "Lower hand" : "Raise hand"}
        </ChalkText>
      </Animated.View>
    </Pressable>
  );
}

function EmojiButton({ emoji, name, onPress, testID }: { readonly emoji: Reaction; readonly name: string; readonly onPress: (emoji: Reaction) => void; readonly testID: string }): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("small");
  const { down } = press;
  const pressed = colors.hover;
  const background = useAnimatedStyle(() => {
    "worklet";
    return { backgroundColor: down.value ? pressed : fixed.transparent };
  });
  return (
    <Pressable accessibilityLabel={`Send ${name}`} accessibilityRole="button" onPress={() => onPress(emoji)} onPressIn={press.onPressIn} onPressOut={press.onPressOut} testID={testID}>
      <Animated.View style={[styles.emoji, background, press.scaleStyle]}>
        <Text allowFontScaling={false} style={styles.emojiText}>
          {emoji}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/** Copy link: the icon turns into a check for two seconds and the screen reader hears "Link copied". */
function CopyLinkRow({ link }: { readonly link: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(reset.current ?? undefined), []);
  const copy = useCallback(async () => {
    await setStringAsync(link);
    setCopied(true);
    announce("Link copied");
    clearTimeout(reset.current ?? undefined);
    reset.current = setTimeout(() => setCopied(false), durations.copyReset);
  }, [link]);
  return <SheetRow icon={copied ? "check" : "copy"} label="Copy link" onPress={() => void copy()} testID="more.copy" />;
}

/** Chat, with the accent dot after its name while messages are unread. */
function ChatRow({ onPress }: { readonly onPress: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const unread = useChat().unreadCount > 0;
  return (
    <SheetRow
      accessibilityLabel={unread ? "Chat, new messages" : "Chat"}
      badge={unread ? <View style={[styles.unread, { backgroundColor: colors.info }]} testID="more.chat.unread" /> : null}
      end={<Icon color={colors.textMuted} name="right" />}
      icon="chat"
      label="Chat"
      onPress={onPress}
      testID="more.chat"
    />
  );
}

function PeopleCount({ count }: { readonly count: number }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.end}>
      <ChalkText tabular tone="textMuted" variant="phoneRow">
        {count}
      </ChalkText>
      <Icon color={colors.textMuted} name="right" />
    </View>
  );
}

/** Hosts start and stop recording; the header's Rec dot shows it to everyone (K5). */
function RecordingRow({ onDone }: { readonly onDone: () => void }): React.JSX.Element | null {
  const client = useSpaceClient();
  const toasts = useToasts();
  const { soundsEnabled } = usePreferences();
  const { colors } = useTheme();
  const canRecord = useCan("manageRecording");
  const status = useRecording().current?.status;
  if (!canRecord) return null;
  const recording = status === "starting" || status === "recording";
  const toggle = () => {
    onDone();
    if (recording) {
      client.recording
        .stop()
        .then(() => {
          toasts.show({ leading: <Icon color={colors.textMuted} name="rec" />, message: "Recording stopped" });
        })
        .catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't stop recording." }));
      return;
    }
    client.recording
      .start()
      .then(() => {
        playSound("recording", soundsEnabled);
        toasts.show({ leading: <Icon color={colors.dangerText} name="rec" />, message: [{ strong: "Recording started." }, " Everyone in the call can see it."] });
      })
      .catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't start recording." }));
  };
  return <SheetRow icon="rec" label={recording ? "Stop recording" : "Start recording"} onPress={toggle} testID="more.recording" />;
}

/** Switches between the front and back cameras while the camera is on. */
function SwitchCameraRow({ onDone }: { readonly onDone: () => void }): React.JSX.Element | null {
  const client = useSpaceClient();
  const toasts = useToasts();
  const media = useMedia();
  const cameras = media.devices.cameras;
  if (media.local.camera.state !== "enabled" || cameras.length < 2) return null;
  const index = cameras.findIndex((camera) => camera.deviceId === media.selection.camera);
  const next = cameras[(index + 1) % cameras.length];
  if (!next) return null;
  const flip = () => {
    onDone();
    client.media
      .selectCamera(next.deviceId)
      .then(() => announce(`Switched to the ${next.label || "other camera"}`))
      .catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't switch camera." }));
  };
  return <SheetRow icon="flip" label="Switch camera" onPress={flip} testID="more.flip" />;
}

const styles = StyleSheet.create({
  // `.rxrow`: wraps onto a second line on narrow phones.
  reactions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, paddingBottom: 12 },
  hand: { flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingLeft: 12, paddingRight: 16, marginRight: 6, borderRadius: 999 },
  emoji: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  emojiText: { fontSize: 22 },
  end: { flexDirection: "row", alignItems: "center", gap: 14 },
  unread: { width: 8, height: 8, borderRadius: 4 },
});
