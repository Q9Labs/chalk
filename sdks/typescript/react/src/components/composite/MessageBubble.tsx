import { CHALK_REACTIONS, type ChatMessage, type ChatReactionInput, type ChatAttachment, type ChatReadReceipt } from "@q9labsai/chalk-client";
import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, Download01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { ChalkPopover } from "../chalk-ui";
import { useChatAttachmentPreviews } from "./use-chat-attachment-previews";

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: string;
  /** Frozen display text for deterministic projections; live views format timestamp locally. */
  displayTime?: string;
  /** Stable message identity for deterministic Chalk chrome across projection seeks. */
  seed?: number | string;
  /** Stable participant identity for the sender avatar's Chalk chrome. */
  avatarSeed?: number | string;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  showAvatar?: boolean;
  generatedAvatars?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  status?: "queued" | "pending" | "sent" | "read";
  attachments?: readonly ChatAttachment[];
  readBy?: readonly ChatReadReceipt[];
  participantNames?: Readonly<Record<string, string>>;
  onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  reactions?: NonNullable<ChatMessage["reactions"]>;
  localParticipantId?: string;
  onReact?: (emoji: ChatReactionInput["emoji"], on: boolean) => Promise<unknown>;
  className?: string;
}

export const MessageBubble = React.memo<MessageBubbleProps>(
  ({
    content,
    senderName,
    senderAvatar,
    timestamp,
    displayTime,
    isLocal = false,
    isSystem = false,
    showSender = true,
    showTimestamp = true,
    showAvatar = true,
    generatedAvatars = true,
    isFirstInGroup = true,
    isLastInGroup = true,
    status = "sent",
    attachments = [],
    readBy = [],
    participantNames = {},
    onResolveAttachmentUrl,
    reactions = [],
    localParticipantId,
    onReact,
    className,
  }) => {
    const { resolvedUrls, failedAttachmentIds, markFailed, retry } = useChatAttachmentPreviews(attachments, onResolveAttachmentUrl);
    const [reactionError, setReactionError] = useState<string | null>(null);
    const [reacting, setReacting] = useState(false);
    const [reactionBarOpen, setReactionBarOpen] = useState(false);
    const messageRef = useRef<HTMLDivElement>(null);
    const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
    const cancelPress = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    };
    useEffect(() => () => cancelPress(), []);
    useEffect(() => {
      if (!reactionBarOpen) return;
      messageRef.current?.querySelector<HTMLButtonElement>(".call-reaction-bar button")?.focus({ preventScroll: true });
      const dismiss = (event: PointerEvent) => {
        if (event.target instanceof Node && !messageRef.current?.contains(event.target)) setReactionBarOpen(false);
      };
      document.addEventListener("pointerdown", dismiss);
      return () => document.removeEventListener("pointerdown", dismiss);
    }, [reactionBarOpen]);
    const [photo, setPhoto] = useState<ChatAttachment | null>(null);
    const photos = attachments.filter((file) => file.mimeType.startsWith("image/") && resolvedUrls.has(file.attachmentId));
    const imageFiles = attachments.filter((file) => file.mimeType.startsWith("image/"));
    const visibleAttachments = [...imageFiles.slice(0, 4), ...attachments.filter((file) => !file.mimeType.startsWith("image/"))];
    const photoIndex = photos.findIndex((file) => file.attachmentId === photo?.attachmentId);
    const changePhoto = (step: number) => {
      if (photos.length > 1) setPhoto(photos[(photoIndex + step + photos.length) % photos.length]!);
    };
    const viewer = useRef<HTMLDialogElement>(null);
    const react = async (emoji: ChatReactionInput["emoji"]) => {
      if (!onReact || reacting) return;
      setReactionBarOpen(false);
      setReacting(true);
      setReactionError(null);
      const mine = reactions.some((reaction) => reaction.emoji === emoji && localParticipantId !== undefined && reaction.participantIds.includes(localParticipantId));
      try {
        await onReact(emoji, !mine);
      } catch (cause) {
        setReactionError(cause instanceof Error ? cause.message : "Couldn’t react to this message.");
      } finally {
        setReacting(false);
      }
    };
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
    if (isSystem) return <p className="call-chat-system">{content}</p>;
    return (
      <div className={cn("call-message-group", isLocal && "is-local", !isFirstInGroup && "is-continuation", className)}>
        {!isLocal && <div className="call-message-avatar">{showAvatar && isFirstInGroup ? <Avatar name={senderName} src={senderAvatar} size="sm" generated={generatedAvatars} className="!h-7 !w-7" /> : null}</div>}
        <div className="call-message-column">
          {isFirstInGroup && (showSender || showTimestamp) ? (
            <div className="call-message-heading">
              {showSender && !isLocal ? (
                <b>
                  <bdi>{senderName}</bdi>
                </b>
              ) : null}
              {showTimestamp ? (displayTime ?? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp))) : null}
            </div>
          ) : null}
          <div
            ref={messageRef}
            className={cn("call-message", reactionBarOpen && "on")}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.pointerType !== "touch" || !onReact || (event.target instanceof Element && event.target.closest("button, a"))) return;
              cancelPress();
              press.current = {
                x: event.clientX,
                y: event.clientY,
                timer: setTimeout(() => {
                  press.current = null;
                  setReactionBarOpen(true);
                }, 450),
              };
            }}
            onPointerMove={(event) => {
              if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress();
            }}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(event) => {
              if (reactionBarOpen) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !reactionBarOpen) return;
              event.preventDefault();
              event.stopPropagation();
              setReactionBarOpen(false);
              messageRef.current?.focus({ preventScroll: true });
            }}
            aria-label={`${isLocal ? "You" : senderName}: ${content || `${attachments.length} attachments`}`}
          >
            {content ? (
              <div className="call-message-bubble" dir="auto">
                {content.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
                  /^https?:\/\//.test(part) ? (
                    <a key={index} href={part} target="_blank" rel="noopener noreferrer">
                      {part}
                    </a>
                  ) : (
                    part
                  ),
                )}
              </div>
            ) : null}
            {attachments.length ? (
              <div className={cn("call-attachments", `image-${Math.min(imageFiles.length, 4)}`)}>
                {visibleAttachments.map((file) => {
                  const image = file.mimeType.startsWith("image/");
                  const url = resolvedUrls.get(file.attachmentId);
                  if (failedAttachmentIds.has(file.attachmentId))
                    return (
                      <div className="call-file" key={file.attachmentId}>
                        <span>
                          <b dir="auto">{file.fileName}</b>
                          <small>Attachment unavailable</small>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            retry(file.attachmentId);
                            if (!image) void openFile(file);
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    );
                  if (image && url)
                    return (
                      <button
                        type="button"
                        className="call-photo"
                        key={file.attachmentId}
                        aria-label={`View ${file.fileName}`}
                        onClick={() => {
                          setPhoto(file);
                          viewer.current?.showModal();
                        }}
                      >
                        <img src={url} alt={file.fileName} onError={() => markFailed(file.attachmentId, "render")} />
                        {imageFiles.length > 4 && imageFiles.indexOf(file) === 3 ? <span className="call-photo-more">+{imageFiles.length - 4}</span> : null}
                      </button>
                    );
                  return (
                    <button type="button" className="call-file" key={file.attachmentId} disabled={!onResolveAttachmentUrl || image} aria-label={`Download ${file.fileName}`} onClick={() => void openFile(file)}>
                      <span className="call-file-type" data-extension={file.fileName.split(".").at(-1)?.toLowerCase()}>
                        {file.fileName.split(".").at(-1)?.toUpperCase()}
                      </span>
                      <span>
                        <b dir="auto">{file.fileName}</b>
                        <small>{image ? "Loading preview…" : `${Math.max(1, Math.round(file.byteLength / 1024))} KB`}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {reactions.length ? (
              <div className="call-message-reactions">
                {reactions.map((reaction) => {
                  const mine = localParticipantId !== undefined && reaction.participantIds.includes(localParticipantId);
                  const names = reaction.participantIds.map((id) => (id === localParticipantId ? "You" : (participantNames[id] ?? id))).join(", ");
                  return (
                    <button type="button" key={reaction.emoji} className="call-reaction" aria-pressed={mine} aria-label={`${reaction.emoji}, ${reaction.count}: ${names}`} title={names} disabled={!onReact || reacting} onClick={() => void react(reaction.emoji)}>
                      <span>{reaction.emoji}</span>
                      <b>{reaction.count}</b>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {onReact && status !== "queued" && status !== "pending" ? (
              <div className="call-reaction-bar" role="group" aria-label="React to this message">
                {CHALK_REACTIONS.slice(0, 5).map((emoji) => (
                  <button type="button" key={emoji} aria-label={`React with ${emoji}`} disabled={reacting} onClick={() => void react(emoji)}>
                    {emoji}
                  </button>
                ))}
                <ChalkPopover
                  label="More reactions"
                  trigger={
                    <button type="button" aria-label="More reactions">
                      ☺
                    </button>
                  }
                >
                  <div className="call-emoji-picker">
                    {CHALK_REACTIONS.map((emoji) => (
                      <button type="button" key={emoji} aria-label={`React with ${emoji}`} disabled={reacting} onClick={() => void react(emoji)}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                </ChalkPopover>
              </div>
            ) : null}
          </div>
          {reactionError ? (
            <p role="alert" className="call-message-status">
              {reactionError}
            </p>
          ) : null}
          {isLocal && isLastInGroup ? <span className="call-message-status">{status === "queued" ? "Queued · sends when you’re back online" : status === "pending" ? "Sending…" : status === "read" || readBy.length > 0 ? "Read" : "Sent"}</span> : null}
        </div>
        <dialog
          ref={viewer}
          className="call-photo-viewer"
          aria-label="Photo viewer"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              changePhoto(event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
          onClose={() => setPhoto(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) viewer.current?.close();
          }}
        >
          <div className="call-photo-viewer-bar">
            <span className="call-photo-viewer-name">
              <b dir="auto">{photo?.fileName}</b>
              <small aria-live="polite">
                {isLocal ? "You" : senderName}, {displayTime ?? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp))}
                {photos.length > 1 ? ` · ${photoIndex + 1} of ${photos.length}` : ""}
              </small>
            </span>
            {photo ? (
              <a className="call-photo-viewer-control" href={resolvedUrls.get(photo.attachmentId)} download={photo.fileName} target="_blank" rel="noopener noreferrer" aria-label={`Download ${photo.fileName}`}>
                <Download01Icon />
              </a>
            ) : null}
            <button type="button" className="call-photo-viewer-control" aria-label="Close photo viewer" onClick={() => viewer.current?.close()}>
              <Cancel01Icon />
            </button>
          </div>
          <div
            className="call-photo-viewer-stage"
            onClick={(event) => {
              if (event.target === event.currentTarget) viewer.current?.close();
            }}
          >
            {photo ? <img src={resolvedUrls.get(photo.attachmentId)} alt={photo.fileName} /> : null}
            {photos.length > 1 ? (
              <>
                <button type="button" className="call-photo-viewer-control call-photo-previous" aria-label="Previous image" onClick={() => changePhoto(-1)}>
                  <ArrowLeft01Icon />
                </button>
                <button type="button" className="call-photo-viewer-control call-photo-next" aria-label="Next image" onClick={() => changePhoto(1)}>
                  <ArrowRight01Icon />
                </button>
              </>
            ) : null}
          </div>
        </dialog>
      </div>
    );
  },
);
MessageBubble.displayName = "MessageBubble";
