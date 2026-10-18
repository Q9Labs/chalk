import { CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatAttachment, type ChatUploadFile } from "@q9labsai/chalk-client";
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSpaceClient } from "../../context/space-client-context";
import { useDeviceLayout } from "../../frame/device-layout";
import { Icon } from "../../icons/Icon";
import { usePressAnimation } from "../../motion/press";
import { announce } from "../../primitives/announce";
import { ChalkText } from "../../primitives/ChalkText";
import { IconButton } from "../../primitives/IconButton";
import { useToasts } from "../../primitives/toast/ToastStack";
import { useTheme } from "../../theme/theme";
import { chatOverlays, fontFamilies } from "../../theme/tokens";
import { FileBadge } from "./attachments";
import { fileKind, formatSize, mimeTypeOf, stagingError, type StagedFile } from "./chat-model";
import { TextField } from "./TextField";

/**
 * The composer (`.comp`): files waiting to be sent, then the field with Attach and Send. It pads
 * itself for the home indicator, and only by 8 pt while the keyboard is up, since the sheet then
 * rides on the keyboard.
 */
export function Composer(): React.JSX.Element {
  const client = useSpaceClient();
  const toasts = useToasts();
  const { colors } = useTheme();
  const layout = useDeviceLayout();
  const keyboard = useAnimatedKeyboard();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [staged, setStaged] = useState<readonly StagedFile[]>([]);
  const nextId = useRef(0);

  const update = useCallback((id: number, change: Partial<StagedFile>) => setStaged((files) => files.map((file) => (file.id === id ? { ...file, ...change } : file))), []);

  const upload = useCallback(
    (file: StagedFile) => {
      client.chat.files
        .upload(file.source)
        .then((attachment) => update(file.id, { state: "ready", attachment }))
        .catch((cause: unknown) => update(file.id, { state: "error", error: cause instanceof Error ? cause.message : "Couldn’t upload" }));
    },
    [client, update],
  );

  const attach = useCallback(async () => {
    const picked = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: [...CHALK_CHAT_ATTACHMENT_MIME_TYPES] });
    if (picked.canceled) return;
    let accepted = staged.filter((file) => file.state !== "error").length;
    const added: StagedFile[] = [];
    for (const asset of picked.assets) {
      const mimeType = mimeTypeOf(asset.name, asset.mimeType);
      const size = asset.size ?? 0;
      const source: ChatUploadFile = { name: asset.name, type: mimeType, size, arrayBuffer: () => new File(asset.uri).arrayBuffer() };
      const error = stagingError({ name: asset.name, mimeType, size }, accepted);
      if (!error) accepted += 1;
      nextId.current += 1;
      added.push({ id: nextId.current, name: asset.name, size, mimeType, source, previewUri: fileKind(mimeType) === "image" ? asset.uri : null, state: error ? "error" : "uploading", attachment: null, error });
    }
    setStaged((files) => [...files, ...added]);
    added.filter((file) => file.state === "uploading").forEach(upload);
    const refused = added.filter((file) => file.state === "error").length;
    const ok = added.length - refused;
    announce(`${ok} file${ok === 1 ? "" : "s"} added${refused ? `, ${refused} can’t be sent` : ""}`);
  }, [staged, upload]);

  const pick = useCallback(() => {
    attach().catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't open your files." }));
  }, [attach, toasts]);

  const ready = staged.flatMap((file) => (file.state === "ready" && file.attachment ? [file.attachment] : []));
  const uploading = staged.some((file) => file.state === "uploading");
  const message = text.trim();
  const canSend = !uploading && (message.length > 0 || ready.length > 0);

  const send = useCallback(() => {
    if (!canSend) return;
    const attachments: readonly ChatAttachment[] = ready;
    setText("");
    setStaged([]);
    // A send that fails stays in the list as "Couldn’t send" with Retry, so nothing more is needed here.
    client.chat.send({ text: message, attachments }).catch(() => undefined);
  }, [canSend, client, message, ready]);

  const padStyle = useAnimatedStyle(() => {
    "worklet";
    return { paddingBottom: keyboard.height.value > 0 ? 8 : layout.insets.bottom + 8 };
  });

  return (
    <Animated.View style={[styles.composer, padStyle]} testID="chat.composer">
      {staged.length > 0 ? (
        <ScrollView accessibilityLabel="Files to send" contentContainerStyle={styles.stagedList} style={styles.staged} testID="chat.staged">
          {staged.map((file) => (
            <StagedChip file={file} key={file.id} onRemove={() => setStaged((files) => files.filter((other) => other.id !== file.id))} />
          ))}
        </ScrollView>
      ) : null}
      <View style={[styles.field, { backgroundColor: colors.raised, borderColor: focused ? colors.text : colors.line }]}>
        <View style={styles.clip}>
          <IconButton accessibilityLabel="Attach files" icon="clip" onPress={pick} size={36} testID="chat.attach" tone="ghost" />
        </View>
        <TextField
          accessibilityLabel="Message everyone"
          blurOnSubmit={false}
          onBlur={() => setFocused(false)}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onSubmitEditing={send}
          placeholder="Message everyone"
          returnKeyType="send"
          submitBehavior="submit"
          testID="chat.input"
          value={text}
        />
        <SendButton disabled={!canSend} onPress={send} />
      </View>
    </Animated.View>
  );
}

function SendButton({ disabled, onPress }: { readonly disabled: boolean; readonly onPress: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("round");
  return (
    <Pressable accessibilityLabel="Send message" accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} testID="chat.send">
      <Animated.View style={[styles.send, { backgroundColor: disabled ? colors.hover : colors.text }, disabled ? null : press.scaleStyle]}>
        <Icon color={disabled ? colors.textMuted : colors.canvas} name="up" size={18} />
      </Animated.View>
    </Pressable>
  );
}

/** A file waiting to be sent (`.chip`): its preview, name and size or what's wrong, and Remove. */
function StagedChip({ file, onRemove }: { readonly file: StagedFile; readonly onRemove: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const failed = file.state === "error";
  const uploading = file.state === "uploading";
  return (
    <View accessible={false} style={[styles.chip, { backgroundColor: colors.raised, borderColor: failed ? colors.danger : colors.line }]} testID={`chat.staged.${file.id}`}>
      <View style={[styles.chipPreview, failed ? styles.faded : null]}>
        {file.previewUri && !failed ? <Image source={{ uri: file.previewUri }} style={styles.chipImage} /> : <FileBadge mimeType={file.mimeType} size={32} />}
        {uploading ? (
          <View style={[StyleSheet.absoluteFill, styles.chipShade]}>
            <ActivityIndicator color={chatOverlays.ring} size="small" />
          </View>
        ) : null}
      </View>
      <View style={styles.chipText}>
        <ChalkText numberOfLines={1} variant="button">
          {file.name}
        </ChalkText>
        <ChalkText color={failed ? colors.dangerText : undefined} style={styles.chipDetail} tone="textMuted" variant="label">
          {failed ? file.error : uploading ? `Uploading, ${formatSize(file.size)}` : formatSize(file.size)}
        </ChalkText>
      </View>
      <Pressable accessibilityLabel={`Remove ${file.name}`} accessibilityRole="button" hitSlop={8} onPress={onRemove} style={({ pressed }) => [styles.remove, pressed ? { backgroundColor: colors.hover } : null]} testID={`chat.staged.remove.${file.id}`}>
        <Icon color={colors.textMuted} name="x" size={16} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: { paddingTop: 8, paddingHorizontal: 12 },
  staged: { maxHeight: 196 },
  stagedList: { gap: 4, paddingBottom: 8 },
  field: { flexDirection: "row", alignItems: "center", height: 44, paddingHorizontal: 4, borderRadius: 999, borderWidth: 1 },
  clip: { marginRight: 2 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  chip: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 6, borderRadius: 12, borderWidth: 1 },
  chipPreview: { width: 32, height: 32 },
  chipImage: { width: 32, height: 32, borderRadius: 7 },
  chipShade: { borderRadius: 7, backgroundColor: chatOverlays.uploading, alignItems: "center", justifyContent: "center" },
  faded: { opacity: 0.5 },
  chipText: { flex: 1, minWidth: 0, gap: 1 },
  chipDetail: { fontFamily: fontFamilies[400], lineHeight: 15 },
  remove: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
