import type { ChatAttachment } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState } from "react";

type AttachmentPreviewFailureOperation = "open" | "render" | "resolve";

export function useChatAttachmentPreviews(attachments: readonly ChatAttachment[], resolveUrl: ((attachmentId: string) => Promise<string>) | undefined) {
  const [resolvedUrls, setResolvedUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [failedAttachmentIds, setFailedAttachmentIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const resolvingAttachmentIds = useRef(new Set<string>());
  const resolvedUrlsRef = useRef(resolvedUrls);
  const failedAttachmentIdsRef = useRef(failedAttachmentIds);
  const currentAttachmentIds = new Set(attachments.map((attachment) => attachment.attachmentId));
  const currentImageIds = new Set(attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).map((attachment) => attachment.attachmentId));
  const currentAttachmentIdsRef = useRef(currentAttachmentIds);
  const currentImageIdsRef = useRef(currentImageIds);
  resolvedUrlsRef.current = resolvedUrls;
  failedAttachmentIdsRef.current = failedAttachmentIds;
  currentAttachmentIdsRef.current = currentAttachmentIds;
  currentImageIdsRef.current = currentImageIds;

  const markFailed = useCallback((attachmentId: string, operation: AttachmentPreviewFailureOperation) => {
    console.warn("Chat attachment preview unavailable.", { attachmentId, operation });
    setResolvedUrls((current) => {
      const next = new Map(current);
      next.delete(attachmentId);
      return next;
    });
    setFailedAttachmentIds((current) => new Set(current).add(attachmentId));
  }, []);

  useEffect(() => {
    if (!resolveUrl) return;
    setResolvedUrls((current) => {
      const next = new Map([...current].filter(([attachmentId]) => currentImageIdsRef.current.has(attachmentId)));
      return next.size === current.size ? current : next;
    });
    setFailedAttachmentIds((current) => {
      const next = new Set([...current].filter((attachmentId) => currentAttachmentIdsRef.current.has(attachmentId)));
      return next.size === current.size ? current : next;
    });

    const pending = attachments.filter((attachment) => attachment.mimeType.startsWith("image/") && !resolvedUrlsRef.current.has(attachment.attachmentId) && !failedAttachmentIdsRef.current.has(attachment.attachmentId) && !resolvingAttachmentIds.current.has(attachment.attachmentId));
    for (const attachment of pending) {
      resolvingAttachmentIds.current.add(attachment.attachmentId);
      void resolveUrl(attachment.attachmentId)
        .then(
          (url) => {
            if (currentImageIdsRef.current.has(attachment.attachmentId)) setResolvedUrls((current) => new Map(current).set(attachment.attachmentId, url));
          },
          () => {
            if (currentImageIdsRef.current.has(attachment.attachmentId)) markFailed(attachment.attachmentId, "resolve");
          },
        )
        .finally(() => resolvingAttachmentIds.current.delete(attachment.attachmentId));
    }
  }, [attachments, markFailed, resolveUrl, retryGeneration]);

  const retry = useCallback((attachmentId: string) => {
    setFailedAttachmentIds((current) => {
      const next = new Set(current);
      next.delete(attachmentId);
      return next;
    });
    setRetryGeneration((current) => current + 1);
  }, []);

  return { resolvedUrls, failedAttachmentIds, markFailed, retry };
}
