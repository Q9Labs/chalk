import type { ChatAttachment } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";

export function SpaceChatAttachment({ attachment, isLocal, onOpen, resolveUrl }: { readonly attachment: ChatAttachment; readonly isLocal: boolean; readonly onOpen: (attachmentId: string) => void; readonly resolveUrl: (attachmentId: string) => Promise<string | null> }): React.JSX.Element {
  const isImage = attachment.mimeType.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (!isImage || previewUrl || previewFailed) return;
    let cancelled = false;
    void resolveUrl(attachment.attachmentId).then(
      (url) => {
        if (cancelled) return;
        if (!url) {
          reportAttachmentPreviewFailure(attachment.attachmentId, "resolve");
          setPreviewFailed(true);
          return;
        }
        setPreviewUrl(url);
        setPreviewFailed(false);
      },
      () => {
        if (cancelled) return;
        reportAttachmentPreviewFailure(attachment.attachmentId, "resolve");
        setPreviewFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attachment.attachmentId, isImage, previewFailed, previewUrl, resolveUrl, retryGeneration]);

  if (!isImage) {
    return (
      <Pressable accessibilityRole="link" onPress={() => onOpen(attachment.attachmentId)} style={({ pressed }) => [styles.attachmentLink, pressed && styles.pressed]}>
        <Text numberOfLines={1} style={[styles.attachment, isLocal && styles.localText]}>
          {attachment.fileName}
        </Text>
      </Pressable>
    );
  }

  if (previewFailed) {
    return (
      <View style={styles.previewError}>
        <Text accessibilityLiveRegion="polite" style={[styles.previewErrorText, isLocal && styles.localText]}>
          Image preview unavailable
        </Text>
        <Pressable
          accessibilityLabel={`Retry preview for ${attachment.fileName}`}
          accessibilityRole="button"
          style={styles.retryButton}
          onPress={() => {
            setPreviewFailed(false);
            setPreviewUrl(null);
            setRetryGeneration((current) => current + 1);
          }}
        >
          <Text style={[styles.retry, isLocal && styles.localText]}>Retry preview</Text>
        </Pressable>
      </View>
    );
  }

  if (!previewUrl) return <Text style={[styles.previewLoading, isLocal && styles.localText]}>Loading {attachment.fileName}…</Text>;

  return (
    <Pressable accessibilityLabel={`Open ${attachment.fileName}`} accessibilityRole="imagebutton" onPress={() => onOpen(attachment.attachmentId)} style={({ pressed }) => [styles.imagePreviewButton, pressed && styles.pressed]}>
      <Image
        accessibilityLabel={attachment.fileName}
        onError={() => {
          reportAttachmentPreviewFailure(attachment.attachmentId, "render");
          setPreviewFailed(true);
          setPreviewUrl(null);
        }}
        resizeMode="cover"
        source={{ uri: previewUrl }}
        style={styles.imagePreview}
      />
    </Pressable>
  );
}

function reportAttachmentPreviewFailure(attachmentId: string, operation: "render" | "resolve"): void {
  console.warn("Chat attachment preview unavailable.", { attachmentId, operation });
}

const styles = StyleSheet.create({
  attachmentLink: { justifyContent: "center", marginTop: 4, maxWidth: "100%", minHeight: 32 },
  attachment: { color: Theme.colors.information, fontSize: 14 },
  imagePreviewButton: { borderRadius: Theme.radius.sm, marginTop: Theme.spacing.sm, maxWidth: "100%", overflow: "hidden" },
  imagePreview: { height: 160, width: 240 },
  previewLoading: { color: Theme.colors.ink2, fontSize: 13, marginTop: Theme.spacing.sm },
  previewError: { borderColor: Theme.colors.line, borderRadius: Theme.radius.sm, borderWidth: 1, marginTop: Theme.spacing.sm, width: 240, maxWidth: "100%", minHeight: 160, justifyContent: "center", alignItems: "center", padding: Theme.spacing.md },
  previewErrorText: { color: Theme.colors.ink2, fontSize: 13 },
  retryButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: Theme.spacing.sm },
  retry: { color: Theme.colors.information, fontSize: 13, fontWeight: "700", marginTop: 6 },
  localText: { color: Theme.colors.surface },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
