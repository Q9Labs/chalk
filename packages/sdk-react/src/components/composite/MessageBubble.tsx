import React, { useEffect, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { Tick01Icon, TickDouble01Icon, FileTextIcon, Download01Icon } from "../../utils/icons";
import { getParticipantColor } from "../../utils/colorGenerator";
import type { ChatAttachment, ChatReadReceipt } from "./chat-types";

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: Date;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  showAvatar?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  status?: "sending" | "sent" | "delivered" | "read";
  attachments?: ChatAttachment[];
  readBy?: ChatReadReceipt[];
  onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  className?: string;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const MessageBubble = React.memo<MessageBubbleProps>(
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
    isFirstInGroup: _isFirstInGroup = true,
    isLastInGroup = true,
    status = "delivered",
    attachments = [],
    readBy = [],
    onResolveAttachmentUrl,
    className,
  }) => {
    const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState<Record<string, string>>({});

    const formatTime = (date: Date) => {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      }).format(date);
    };

    const senderColors = useMemo(() => getParticipantColor(senderName), [senderName]);

    useEffect(() => {
      if (!onResolveAttachmentUrl) return;

      const pendingImages = attachments.filter((attachment) => attachment.mimeType.startsWith("image/") && !attachment.url && !resolvedAttachmentUrls[attachment.id]);
      if (pendingImages.length === 0) return;

      let cancelled = false;
      void Promise.all(
        pendingImages.map(async (attachment) => {
          try {
            const url = await onResolveAttachmentUrl(attachment.id);
            return [attachment.id, url] as const;
          } catch {
            return null;
          }
        }),
      ).then((entries) => {
        if (cancelled) return;
        const nextEntries = entries.filter((entry): entry is readonly [string, string] => entry !== null);
        if (nextEntries.length === 0) return;
        setResolvedAttachmentUrls((current) => ({
          ...current,
          ...Object.fromEntries(nextEntries),
        }));
      });

      return () => {
        cancelled = true;
      };
    }, [attachments, onResolveAttachmentUrl, resolvedAttachmentUrls]);

    const handleAttachmentClick = async (attachment: ChatAttachment) => {
      if (onResolveAttachmentUrl) {
        try {
          const url = await onResolveAttachmentUrl(attachment.id);
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {
          return;
        }
      } else if (attachment.url) {
        window.open(attachment.url, "_blank", "noopener,noreferrer");
      }
    };

    const renderContent = (text: string) => {
      if (!text) return null;
      const parts = text.split(URL_REGEX);

      return parts.map((part, index) => {
        if (part.match(URL_REGEX)) {
          return (
            <a key={index} href={part} target="_blank" rel="noopener noreferrer" className={cn("underline break-all", isLocal ? "text-primary-foreground" : "text-primary")}>
              {part}
            </a>
          );
        }
        return <span key={index}>{part}</span>;
      });
    };

    const renderAttachments = () => {
      if (!attachments || attachments.length === 0) return null;

      return (
        <div className={cn("flex flex-col gap-2 mt-2", isLocal ? "items-end" : "items-start")}>
          {attachments.map((file) => {
            const isImage = file.mimeType.startsWith("image/");
            const imageUrl = file.url ?? resolvedAttachmentUrls[file.id];

            if (isImage && imageUrl) {
              return (
                <button key={file.id} onClick={() => handleAttachmentClick(file)} className="relative group overflow-hidden rounded-lg border border-border/50 max-w-full sm:max-w-xs aspect-auto">
                  <img src={imageUrl} alt={file.fileName} className="w-full h-auto object-cover transition-transform group-hover:scale-105" style={{ maxHeight: "240px" }} />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Download01Icon className="w-8 h-8 text-white" />
                  </div>
                </button>
              );
            }

            return (
              <button
                key={file.id}
                onClick={() => handleAttachmentClick(file)}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-xl border transition-all text-left max-w-full sm:max-w-sm",
                  isLocal ? "bg-primary-foreground/10 border-primary-foreground/20 hover:bg-primary-foreground/20 text-primary-foreground" : "bg-muted/50 border-border/50 hover:bg-muted/80 text-foreground",
                )}
              >
                <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0", isLocal ? "bg-primary-foreground/20" : "bg-primary/10 text-primary")}>
                  <FileTextIcon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.fileName}</p>
                  <p className={cn("text-[11px]", isLocal ? "text-primary-foreground/70" : "text-muted-foreground")}>{formatFileSize(file.sizeBytes)}</p>
                </div>
              </button>
            );
          })}
        </div>
      );
    };

    const renderStatus = () => {
      if (!isLocal) return null;

      const readByCount = readBy.length;
      const isRead = status === "read" || readByCount > 0;
      const statusLabel = status === "sending" ? "Sending" : isRead ? "Read" : status === "delivered" ? "Sent" : "Sent";
      const statusTitle = readByCount > 0 ? `Read by: ${readBy.map((receipt) => receipt.displayName).join(", ")}` : statusLabel;

      return (
        <div className="flex items-center gap-1 group/status relative" title={statusTitle}>
          {status === "sending" ? (
            <div className="w-3 h-3 rounded-full animate-spin border-2 border-muted-foreground/40 border-t-transparent" />
          ) : isRead ? (
            <TickDouble01Icon className="w-3.5 h-3.5 text-primary" />
          ) : status === "delivered" ? (
            <TickDouble01Icon className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <Tick01Icon className="w-3.5 h-3.5 text-muted-foreground" />
          )}
          <span className={cn("text-[11px]", isRead ? "text-primary" : "text-muted-foreground")}>{statusLabel}</span>

          {isLocal && readByCount > 0 && (
            <div className="invisible group-hover/status:visible absolute bottom-full right-0 mb-2 whitespace-nowrap bg-popover text-popover-foreground px-2 py-1 rounded text-[10px] shadow-lg border border-border z-10">Read by: {readBy.map((r) => r.displayName).join(", ")}</div>
          )}
        </div>
      );
    };

    if (isSystem) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-3", className)}>
          <div className="px-4 py-2 rounded-full bg-muted text-muted-foreground">
            <p className="text-xs text-center">{renderContent(content)}</p>
          </div>
          {showTimestamp && <span className="text-[11px] text-muted-foreground">{formatTime(timestamp)}</span>}
        </div>
      );
    }

    return (
      <div className={cn("flex items-end gap-3 w-full px-4", isLastInGroup ? "mb-4" : "mb-1", isLocal ? "justify-end" : "justify-start", className)} style={{ "--primary": senderColors.primary } as React.CSSProperties}>
        {!isLocal && <div className="shrink-0 w-10">{showAvatar && isLastInGroup && <Avatar name={senderName} src={senderAvatar} size="sm" className="!w-10 !h-10" />}</div>}

        <div className={cn("flex flex-col max-w-[70%]", isLocal ? "items-end" : "items-start")}>
          <div className={cn("px-4 py-3", isLocal ? "bg-primary text-primary-foreground rounded-[20px_4px_20px_20px]" : "bg-card text-card-foreground rounded-[4px_20px_20px_20px]")}>
            <p className="text-sm leading-relaxed break-words">{renderContent(content)}</p>
            {renderAttachments()}
          </div>

          {showTimestamp && isLastInGroup && (
            <div className={cn("flex items-center gap-1.5 mt-1 px-1", isLocal ? "flex-row-reverse" : "flex-row")}>
              <span className="text-[11px] text-muted-foreground">{formatTime(timestamp)}</span>
              {renderStatus()}
            </div>
          )}
        </div>

        {isLocal && <div className="shrink-0 w-10">{showAvatar && isLastInGroup && <Avatar name={senderName} src={senderAvatar} size="sm" className="!w-10 !h-10" />}</div>}
      </div>
    );
  },
);

MessageBubble.displayName = "MessageBubble";
