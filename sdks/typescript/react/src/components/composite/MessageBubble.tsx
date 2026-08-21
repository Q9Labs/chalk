import type { ChatAttachment, ChatReadReceipt } from "@q9labsai/chalk-client";
import React, { useEffect, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { Tick01Icon, TickDouble01Icon, FileTextIcon, Download01Icon } from "../../utils/icons";
import { getParticipantColor } from "../../utils/colorGenerator";
import { ChalkBadge, ChalkButton, ChalkChrome, ChalkPanel, ChalkSpinner } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicMessageBubble } from "./ClassicMessageBubble";

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: string;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  showAvatar?: boolean;
  generatedAvatars?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  status?: "pending" | "sent" | "read";
  attachments?: readonly ChatAttachment[];
  readBy?: readonly ChatReadReceipt[];
  participantNames?: Readonly<Record<string, string>>;
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

const ChalkMessageBubble = React.memo<MessageBubbleProps>(
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
    const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState<Record<string, string>>({});

    const formatTime = (value: string) => {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      }).format(new Date(value));
    };

    const senderColors = useMemo(() => getParticipantColor(senderName), [senderName]);

    useEffect(() => {
      if (!onResolveAttachmentUrl) return;

      const pendingImages = attachments.filter((attachment) => attachment.mimeType.startsWith("image/") && !resolvedAttachmentUrls[attachment.attachmentId]);
      if (pendingImages.length === 0) return;

      let cancelled = false;
      void Promise.all(
        pendingImages.map(async (attachment) => {
          try {
            const url = await onResolveAttachmentUrl(attachment.attachmentId);
            return [attachment.attachmentId, url] as const;
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
      if (!onResolveAttachmentUrl) return;
      const popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      try {
        const url = await onResolveAttachmentUrl(attachment.attachmentId);
        if (popup) popup.location.href = url;
      } catch {
        popup?.close();
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
            const imageUrl = resolvedAttachmentUrls[file.attachmentId];

            if (isImage && imageUrl) {
              return (
                <ChalkButton
                  type="button"
                  variant="outline"
                  tone={isLocal ? "accent" : "neutral"}
                  key={file.attachmentId}
                  onClick={() => void handleAttachmentClick(file)}
                  disabled={!onResolveAttachmentUrl}
                  className="h-auto max-w-full overflow-hidden p-0 sm:max-w-xs"
                  aria-label={`Download ${file.fileName}`}
                >
                  <ChalkChrome className="absolute inset-0 h-full w-full" filled fill={isLocal ? "var(--chalk-accent)" : "var(--chalk-surface)"} part="attachment-preview" />
                  <img src={imageUrl} alt={file.fileName} className="w-full h-auto object-cover transition-transform group-hover:scale-105" style={{ maxHeight: "240px" }} />
                  <div className="absolute inset-0 flex items-center justify-center bg-[var(--chalk-text)] opacity-0 transition-opacity group-hover:opacity-100">
                    <Download01Icon className="w-8 h-8 text-[var(--chalk-accent-text)]" />
                  </div>
                </ChalkButton>
              );
            }

            return (
              <ChalkButton
                type="button"
                variant="outline"
                tone={isLocal ? "accent" : "neutral"}
                key={file.attachmentId}
                onClick={() => void handleAttachmentClick(file)}
                disabled={!onResolveAttachmentUrl}
                aria-label={`Download ${file.fileName}`}
                className={cn("h-auto max-w-full justify-start rounded-xl p-3 text-left sm:max-w-sm", isLocal ? "text-[var(--chalk-accent)]" : "text-[var(--chalk-text)]")}
              >
                <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0", isLocal ? "bg-[var(--chalk-surface)] text-[var(--chalk-accent)]" : "bg-[var(--chalk-stage)] text-[var(--chalk-accent)]")}>
                  <FileTextIcon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.fileName}</p>
                  <p className={cn("text-[11px]", isLocal ? "text-[var(--chalk-accent-text)]" : "text-[var(--chalk-muted-text)]")}>{formatFileSize(file.byteLength)}</p>
                </div>
              </ChalkButton>
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
          {status === "pending" ? <ChalkSpinner className="size-3" label="Pending" /> : isRead ? <TickDouble01Icon className="w-3.5 h-3.5 text-[var(--chalk-accent)]" /> : <Tick01Icon className="w-3.5 h-3.5 text-[var(--chalk-muted-text)]" />}
          <span className={cn("text-[11px]", isRead ? "text-[var(--chalk-accent)]" : "text-[var(--chalk-muted-text)]")}>{statusLabel}</span>

          {isLocal && readByCount > 0 && <ChalkPanel className="invisible absolute bottom-full right-0 z-10 mb-2 whitespace-nowrap px-2 py-1 text-[10px] shadow-lg group-hover/status:visible">Read by: {readers.join(", ")}</ChalkPanel>}
        </div>
      );
    };

    if (isSystem) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-3", className)}>
          <ChalkBadge className="rounded-full px-4 py-2 text-[var(--chalk-muted-text)]">
            <span className="block text-center text-xs">{renderContent(content)}</span>
          </ChalkBadge>
          {showTimestamp && <span className="text-[11px] text-[var(--chalk-muted-text)]">{formatTime(timestamp)}</span>}
        </div>
      );
    }

    return (
      <div className={cn("flex items-end gap-3 w-full px-4", isLastInGroup ? "mb-4" : "mb-1", isLocal ? "justify-end" : "justify-start", className)} style={{ "--primary": senderColors.primary } as React.CSSProperties}>
        {!isLocal && <div className="flex w-10 shrink-0 justify-center">{showAvatar && isLastInGroup && <Avatar name={senderName} src={senderAvatar} size="sm" generated={generatedAvatars} />}</div>}

        <div className={cn("flex flex-col max-w-[70%]", isLocal ? "items-end" : "items-start")}>
          <ChalkPanel tone={isLocal ? "accent" : "neutral"} className={cn("px-4 py-3", isLocal ? "rounded-[16px_4px_16px_16px] text-[var(--chalk-accent-text)]" : "rounded-[4px_16px_16px_16px] text-[var(--chalk-text)]")}>
            <p className="text-sm leading-relaxed break-words">{renderContent(content)}</p>
            {renderAttachments()}
          </ChalkPanel>

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

export const MessageBubble = React.memo<MessageBubbleProps>((props) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicMessageBubble {...props} /> : <ChalkMessageBubble {...props} />;
});

MessageBubble.displayName = "MessageBubble";
