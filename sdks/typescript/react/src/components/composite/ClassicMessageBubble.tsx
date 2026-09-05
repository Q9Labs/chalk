import type { ChatAttachment } from "@q9labsai/chalk-client";
import React, { useMemo } from "react";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { Tick01Icon, TickDouble01Icon, FileTextIcon, Download01Icon } from "../../utils/icons";
import { getParticipantColor } from "../../utils/colorGenerator";
import type { MessageBubbleProps } from "./MessageBubble";
import { useChatAttachmentPreviews } from "./use-chat-attachment-previews";

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const ClassicMessageBubble = React.memo<MessageBubbleProps>(
  ({
    content,
    senderName,
    senderAvatar,
    timestamp,
    isLocal = false,
    isSystem = false,
    showSender: _showSender = true,
    showTimestamp = true,
    showAvatar = true,
    generatedAvatars = true,
    isFirstInGroup: _isFirstInGroup = true,
    isLastInGroup = true,
    status = "sent",
    attachments = [],
    readBy = [],
    participantNames = {},
    onResolveAttachmentUrl,
    className,
  }) => {
    const { resolvedUrls, failedAttachmentIds, markFailed, retry } = useChatAttachmentPreviews(attachments, onResolveAttachmentUrl);

    const formatTime = (value: string) => {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      }).format(new Date(value));
    };

    const senderColors = useMemo(() => getParticipantColor(senderName), [senderName]);

    const handleAttachmentClick = async (attachment: ChatAttachment) => {
      if (!onResolveAttachmentUrl) return;
      const popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      try {
        const url = await onResolveAttachmentUrl(attachment.attachmentId);
        if (popup) popup.location.href = url;
      } catch {
        popup?.close();
        markFailed(attachment.attachmentId, "open");
      }
    };

    const renderContent = (text: string) => {
      if (!text) return null;
      const parts = text.split(URL_REGEX);

      return parts.map((part, index) => {
        if (part.match(URL_REGEX)) {
          return (
            <a key={index} href={part} target="_blank" rel="noopener noreferrer" className={cn("underline break-all", isLocal ? "text-[var(--chalk-accent-text)]" : "text-[var(--chalk-accent)]")}>
              {part}
            </a>
          );
        }
        return <span key={index}>{part}</span>;
      });
    };

    const renderAttachments = () => {
      if (attachments.length === 0) return null;

      return (
        <div className={cn("flex flex-col gap-2 mt-2", isLocal ? "items-end" : "items-start")}>
          {attachments.map((file) => {
            const isImage = file.mimeType.startsWith("image/");
            const imageUrl = resolvedUrls.get(file.attachmentId);
            const previewFailed = failedAttachmentIds.has(file.attachmentId);

            if (previewFailed) {
              return (
                <div key={file.attachmentId} role="status" className="max-w-full rounded-xl border border-[var(--chalk-line)] p-3 text-left sm:max-w-sm">
                  <p className="truncate text-sm font-medium">{file.fileName}</p>
                  <p className="mt-1 text-xs">{isImage ? "Preview" : "Attachment"} could not be loaded.</p>
                  <button
                    type="button"
                    className="mt-1 min-h-11 rounded-md px-2 text-xs font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => {
                      retry(file.attachmentId);
                      if (!isImage) void handleAttachmentClick(file);
                    }}
                  >
                    {isImage ? "Retry preview" : "Retry"}
                  </button>
                </div>
              );
            }

            if (isImage && imageUrl) {
              return (
                <button type="button" key={file.attachmentId} onClick={() => void handleAttachmentClick(file)} className="relative group overflow-hidden rounded-lg border border-[var(--chalk-line)] max-w-full sm:max-w-xs aspect-auto" aria-label={`Download ${file.fileName}`}>
                  <img src={imageUrl} alt={file.fileName} className="w-full h-auto object-cover transition-transform group-hover:scale-105" style={{ maxHeight: "240px" }} onError={() => markFailed(file.attachmentId, "render")} />
                  <div className="absolute inset-0 bg-[var(--chalk-text)] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Download01Icon className="w-8 h-8 text-[var(--chalk-accent-text)]" />
                  </div>
                </button>
              );
            }

            return (
              <button
                type="button"
                key={file.attachmentId}
                onClick={() => void handleAttachmentClick(file)}
                disabled={!onResolveAttachmentUrl}
                aria-label={`Download ${file.fileName}`}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-xl border transition-all text-left max-w-full sm:max-w-sm",
                  isLocal ? "border-[var(--chalk-accent-text)] bg-[var(--chalk-surface)] text-[var(--chalk-accent)] hover:bg-[var(--chalk-stage)]" : "border-[var(--chalk-line)] bg-[var(--chalk-stage)] text-[var(--chalk-text)] hover:bg-[var(--chalk-stage)]",
                )}
              >
                <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0", isLocal ? "bg-[var(--chalk-surface)] text-[var(--chalk-accent)]" : "bg-[var(--chalk-stage)] text-[var(--chalk-accent)]")}>
                  <FileTextIcon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.fileName}</p>
                  <p className={cn("text-[11px]", isLocal ? "text-[var(--chalk-accent-text)]" : "text-[var(--chalk-muted-text)]")}>{isImage && onResolveAttachmentUrl ? "Loading preview…" : formatFileSize(file.byteLength)}</p>
                </div>
              </button>
            );
          })}
        </div>
      );
    };

    const renderStatus = () => {
      if (!isLocal) return null;

      const readers = readBy.map((receipt) => participantNames[receipt.participantId] ?? receipt.participantId);
      const readByCount = readers.length;
      const isRead = status === "read" || readByCount > 0;
      const statusLabel = status === "pending" ? "Pending" : isRead ? "Read" : "Sent";
      const statusTitle = readByCount > 0 ? `Read by: ${readers.join(", ")}` : statusLabel;

      return (
        <div className="flex items-center gap-1 group/status relative" title={statusTitle}>
          {status === "pending" ? <div className="w-3 h-3 rounded-full animate-spin border-2 border-[var(--chalk-line)] border-t-transparent" /> : isRead ? <TickDouble01Icon className="w-3.5 h-3.5 text-[var(--chalk-accent)]" /> : <Tick01Icon className="w-3.5 h-3.5 text-[var(--chalk-muted-text)]" />}
          <span className={cn("text-[11px]", isRead ? "text-[var(--chalk-accent)]" : "text-[var(--chalk-muted-text)]")}>{statusLabel}</span>

          {isLocal && readByCount > 0 && (
            <div className="invisible group-hover/status:visible absolute bottom-full right-0 mb-2 whitespace-nowrap bg-[var(--chalk-surface)] text-[var(--chalk-text)] px-2 py-1 rounded text-[10px] shadow-lg border border-[var(--chalk-line)] z-10">Read by: {readers.join(", ")}</div>
          )}
        </div>
      );
    };

    if (isSystem) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-3", className)}>
          <div className="px-4 py-2 rounded-full bg-[var(--chalk-stage)] text-[var(--chalk-muted-text)]">
            <p className="text-xs text-center">{renderContent(content)}</p>
          </div>
          {showTimestamp && <span className="text-[11px] text-[var(--chalk-muted-text)]">{formatTime(timestamp)}</span>}
        </div>
      );
    }

    return (
      <div className={cn("flex items-end gap-3 w-full px-4", isLastInGroup ? "mb-4" : "mb-1", isLocal ? "justify-end" : "justify-start", className)} style={{ "--primary": senderColors.primary } as React.CSSProperties}>
        {!isLocal && <div className="flex w-10 shrink-0 justify-center">{showAvatar && isLastInGroup && <Avatar name={senderName} src={senderAvatar} size="sm" generated={generatedAvatars} />}</div>}

        <div className={cn("flex flex-col max-w-[70%]", isLocal ? "items-end" : "items-start")}>
          <div className={cn("chalk-textured-surface px-4 py-3", isLocal ? "rounded-[16px_4px_16px_16px] bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)]" : "rounded-[4px_16px_16px_16px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)]")}>
            <p className="text-sm leading-relaxed break-words">{renderContent(content)}</p>
            {renderAttachments()}
          </div>

          {showTimestamp && isLastInGroup && (
            <div className={cn("flex items-center gap-1.5 mt-1 px-1", isLocal ? "flex-row-reverse" : "flex-row")}>
              <span className="text-[11px] text-[var(--chalk-muted-text)]">{formatTime(timestamp)}</span>
              {renderStatus()}
            </div>
          )}
        </div>

        {isLocal && <div className="flex w-10 shrink-0 justify-center">{showAvatar && isLastInGroup && <Avatar name={senderName} src={senderAvatar} size="sm" generated={generatedAvatars} />}</div>}
      </div>
    );
  },
);

ClassicMessageBubble.displayName = "MessageBubble";
