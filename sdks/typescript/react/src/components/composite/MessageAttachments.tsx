import type { ChatAttachment } from "@q9labsai/chalk-client";
import { cn } from "../../utils/cn";
import { UnavailableAttachment } from "./UnavailableAttachment";

type MarkAttachmentFailed = (attachmentId: string, operation: "open" | "render" | "resolve") => void;

interface MessageAttachmentsProps {
  readonly attachments: readonly ChatAttachment[];
  readonly resolvedUrls: ReadonlyMap<string, string>;
  readonly failedAttachmentIds: ReadonlySet<string>;
  readonly onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  readonly onOpenAttachmentOnStage?: (attachment: ChatAttachment) => Promise<void>;
  readonly retry: (attachmentId: string) => void;
  readonly markFailed: MarkAttachmentFailed;
  readonly onPhotoOpen: (file: ChatAttachment) => void;
}

export function MessageAttachments({ attachments, resolvedUrls, failedAttachmentIds, onResolveAttachmentUrl, onOpenAttachmentOnStage, retry, markFailed, onPhotoOpen }: MessageAttachmentsProps) {
  const openFile = async (file: ChatAttachment) => {
    if (!onResolveAttachmentUrl) return;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const url = await onResolveAttachmentUrl(file.attachmentId);
      if (popup) popup.location.href = url;
    } catch {
      popup?.close();
      markFailed(file.attachmentId, "open");
    }
  };
  const downloadFile = async (file: ChatAttachment) => {
    if (!onResolveAttachmentUrl) return;
    try {
      const url = await onResolveAttachmentUrl(file.attachmentId);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.rel = "noopener";
      anchor.click();
    } catch {
      markFailed(file.attachmentId, "open");
    }
  };
  const imageFiles = attachments.filter((file) => file.mimeType.startsWith("image/"));
  const visibleAttachments = [...imageFiles.slice(0, 4), ...attachments.filter((file) => !file.mimeType.startsWith("image/"))];
  return (
    <div className={cn("call-attachments", `image-${Math.min(imageFiles.length, 4)}`)}>
      {visibleAttachments.map((file) => {
        const image = file.mimeType.startsWith("image/");
        const url = resolvedUrls.get(file.attachmentId);
        if (failedAttachmentIds.has(file.attachmentId))
          return (
            <UnavailableAttachment
              key={file.attachmentId}
              fileName={file.fileName}
              onTryAgain={() => {
                retry(file.attachmentId);
                if (!image) void openFile(file);
              }}
            />
          );
        if (image && url)
          return (
            <button type="button" className="call-photo" key={file.attachmentId} aria-label={`View ${file.fileName}`} onClick={() => onPhotoOpen(file)}>
              <img src={url} alt={file.fileName} onError={() => markFailed(file.attachmentId, "render")} />
              {imageFiles.length > 4 && imageFiles.indexOf(file) === 3 ? <span className="call-photo-more">+{imageFiles.length - 4}</span> : null}
            </button>
          );
        const presentable = file.mimeType === "application/pdf" || file.mimeType.startsWith("image/");
        return (
          <span className="call-file-wrap" key={file.attachmentId}>
            <button type="button" className="call-file" disabled={!onResolveAttachmentUrl || image} aria-label={`Download ${file.fileName}`} onClick={() => void openFile(file)}>
              <span className="call-file-type" data-extension={file.fileName.split(".").at(-1)?.toLowerCase()}>
                {file.fileName.split(".").at(-1)?.toUpperCase()}
              </span>
              <span>
                <b dir="auto">{file.fileName}</b>
                <small>{image ? "Loading preview…" : `${Math.max(1, Math.round(file.byteLength / 1024))} KB`}</small>
              </span>
            </button>
            <span className="call-file-actions">
              {presentable && onOpenAttachmentOnStage ? (
                <button type="button" onClick={() => void onOpenAttachmentOnStage(file)}>
                  Open on stage
                </button>
              ) : null}
              <button type="button" onClick={() => void openFile(file)}>
                Open in new tab
              </button>
              <button type="button" onClick={() => void downloadFile(file)}>
                Download
              </button>
            </span>
          </span>
        );
      })}
    </div>
  );
}
