import type { ChatAttachment, SpaceClient } from "@q9labsai/chalk-client";
import { memo, useEffect, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { useSpaceClient } from "../../context/space-client-context";
import { Icon } from "../../icons/Icon";
import { ChalkText } from "../../primitives/ChalkText";
import { IconButton } from "../../primitives/IconButton";
import { useToasts } from "../../primitives/toast/ToastStack";
import { useTheme } from "../../theme/theme";
import { chatOverlays, fileKindColors, fixed, fontFamilies } from "../../theme/tokens";
import { FILE_BADGE, fileKind, formatSize, thumbnailLayout } from "./chat-model";

/** Download links for this session, so a photo scrolled back into view doesn't ask the server again. */
const urls = new Map<string, Promise<string>>();

function resolveUrl(client: SpaceClient, attachment: ChatAttachment): Promise<string> {
  let url = urls.get(attachment.attachmentId);
  if (!url) {
    url = client.chat.files.resolveUrl(attachment);
    urls.set(attachment.attachmentId, url);
    url.catch(() => urls.delete(attachment.attachmentId));
  }
  return url;
}

export type AttachmentSource = { readonly state: "loading" } | { readonly state: "ready"; readonly uri: string; readonly aspect: number } | { readonly state: "failed" };

/** The download link of a photo and its shape, once both are known. */
export function useAttachmentSource(attachment: ChatAttachment): AttachmentSource {
  const client = useSpaceClient();
  const [source, setSource] = useState<AttachmentSource>({ state: "loading" });
  useEffect(() => {
    let live = true;
    resolveUrl(client, attachment)
      .then((uri) => {
        Image.getSize(
          uri,
          (width, height) => live && setSource({ state: "ready", uri, aspect: width / height }),
          () => live && setSource({ state: "ready", uri, aspect: 4 / 3 }),
        );
      })
      .catch(() => live && setSource({ state: "failed" }));
    return () => {
      live = false;
    };
  }, [attachment, client]);
  return source;
}

/** Opens a file in the system viewer, which offers saving and sharing. */
export function useDownload(): (attachment: ChatAttachment) => void {
  const client = useSpaceClient();
  const toasts = useToasts();
  return (attachment) => {
    resolveUrl(client, attachment)
      .then((uri) => Linking.openURL(uri))
      .catch(() => toasts.show({ kind: "error", dismissible: true, message: `Couldn't download ${attachment.fileName}.` }));
  };
}

type ThumbnailsProps = {
  readonly photos: readonly ChatAttachment[];
  readonly disabled: boolean;
  readonly onOpen: (index: number) => void;
};

/** A message's photos (`.ths`): one at its own shape, or a grid of up to four with "+N" on the last. */
export const Thumbnails = memo(function Thumbnails({ photos, disabled, onOpen }: ThumbnailsProps): React.JSX.Element {
  const { shown, more } = thumbnailLayout(photos.length);
  const count = photos.length;
  return (
    <View style={[styles.grid, count > 1 ? styles.gridMany : null]}>
      {photos.slice(0, shown).map((photo, index) => (
        <Thumbnail
          attachment={photo}
          disabled={disabled}
          key={photo.attachmentId}
          label={`Open ${photo.fileName}${count > 1 ? `, ${index + 1} of ${count}` : ""}${index === 3 && more > 0 ? `, and ${more} more` : ""}`}
          layout={count === 1 ? "one" : count === 3 && index === 2 ? "wide" : "square"}
          more={index === 3 ? more : 0}
          onPress={() => onOpen(index)}
        />
      ))}
    </View>
  );
});

type ThumbnailProps = {
  readonly attachment: ChatAttachment;
  readonly layout: "one" | "square" | "wide";
  readonly more: number;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
};

function Thumbnail({ attachment, layout, more, label, disabled, onPress }: ThumbnailProps): React.JSX.Element {
  const { colors } = useTheme();
  const source = useAttachmentSource(attachment);
  const aspectRatio = layout === "one" ? (source.state === "ready" ? Math.min(1.78, Math.max(0.75, source.aspect)) : 4 / 3) : layout === "wide" ? 2 : 1;
  const style = [styles.thumb, layout === "one" ? styles.thumbOne : layout === "wide" ? styles.thumbWide : styles.thumbSquare, { aspectRatio, backgroundColor: colors.raised }];
  if (source.state !== "ready") {
    return (
      <View accessibilityLabel={source.state === "loading" ? `Loading ${attachment.fileName}` : `Couldn't load ${attachment.fileName}`} accessibilityRole="image" accessible style={[style, styles.centered]}>
        <Icon color={colors.textMuted} name="img" size={18} />
      </View>
    );
  }
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="imagebutton" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={style} testID={`chat.photo.${attachment.attachmentId}`}>
      <Image source={{ uri: source.uri }} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: layout === "one" ? 14 : 3, boxShadow: `inset 0px 0px 0px 1px ${colors.line}` }]} />
      {more > 0 ? (
        <View style={[StyleSheet.absoluteFill, styles.centered, styles.moreShade]}>
          <ChalkText color={fixed.overlayText} style={styles.moreText} variant="sheetTitle">
            {`+${more}`}
          </ChalkText>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A file's coloured badge (`.fi`): its kind in two to four letters, or a photo icon. */
export function FileBadge({ mimeType, size = 36 }: { readonly mimeType: string; readonly size?: 32 | 36 }): React.JSX.Element {
  const { colors } = useTheme();
  const kind = fileKind(mimeType);
  const box = { width: size, height: size, borderRadius: size === 36 ? 9 : 7 };
  if (kind === "image") {
    return (
      <View style={[styles.badge, box, { backgroundColor: colors.hover }]}>
        <Icon color={colors.textMuted} name="img" size={18} />
      </View>
    );
  }
  const color = kind === "txt" ? fileKindColors.other : fileKindColors[kind];
  return (
    <View style={[styles.badge, box, { backgroundColor: color }]}>
      <ChalkText color={fixed.overlayText} style={[styles.badgeText, size === 32 ? styles.badgeTextSmall : null]} variant="caption">
        {FILE_BADGE[kind]}
      </ChalkText>
    </View>
  );
}

/** A file in a message (`.fcard`) with its name, size and a download button. */
export const FileCard = memo(function FileCard({ attachment, sent }: { readonly attachment: ChatAttachment; readonly sent: boolean }): React.JSX.Element {
  const { colors } = useTheme();
  const download = useDownload();
  return (
    <View style={[styles.file, { backgroundColor: colors.raised, borderColor: colors.line }]} testID={`chat.file.${attachment.attachmentId}`}>
      <FileBadge mimeType={attachment.mimeType} />
      <View style={styles.fileText}>
        <ChalkText numberOfLines={1} variant="button">
          {attachment.fileName}
        </ChalkText>
        <ChalkText style={styles.fileSize} tone="textMuted" variant="label">
          {formatSize(attachment.byteLength)}
        </ChalkText>
      </View>
      {sent ? <IconButton accessibilityLabel={`Download ${attachment.fileName}`} icon="dl" onPress={() => download(attachment)} size={36} testID={`chat.download.${attachment.attachmentId}`} tone="ghost" /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  grid: { width: 240, maxWidth: "100%", borderRadius: 14, overflow: "hidden" },
  gridMany: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  thumb: { overflow: "hidden" },
  thumbOne: { width: "100%", borderRadius: 14 },
  thumbSquare: { width: 119, borderRadius: 3 },
  thumbWide: { width: "100%", borderRadius: 3 },
  centered: { alignItems: "center", justifyContent: "center" },
  moreShade: { backgroundColor: chatOverlays.photoMore },
  moreText: { fontSize: 20, lineHeight: 28 },
  badge: { alignItems: "center", justifyContent: "center" },
  // `.fi`: 10 pt bold capitals with 0.04 em tracking.
  badgeText: { fontFamily: fontFamilies[700], fontSize: 10, lineHeight: 10, letterSpacing: 0.4 },
  badgeTextSmall: { fontSize: 9, lineHeight: 9, letterSpacing: 0.36 },
  file: { flexDirection: "row", alignItems: "center", gap: 10, width: 240, maxWidth: "100%", minHeight: 56, paddingTop: 8, paddingRight: 6, paddingBottom: 8, paddingLeft: 10, borderRadius: 14, borderWidth: 1 },
  fileText: { flex: 1, minWidth: 0, gap: 1 },
  fileSize: { fontFamily: fontFamilies[400], lineHeight: 15 },
});
