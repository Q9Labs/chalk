import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES } from "@q9labsai/chalk-client";
import type { ChatAttachment, ChatReadReceipt, ChatSendInput, ChatUploadFile, ChatReactionInput, SpaceSnapshot } from "@q9labsai/chalk-client";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCan, useChat, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { Cancel01Icon } from "../../utils/icons";
import { Button } from "@q9labsai/chalk-ui";
import { CallCardStyles } from "../call-card/CallCardStyles";
import { MessageBubble } from "./MessageBubble";
import { compareChatSequence, createChatScrollWork, groupChatMessages, isChatScrollAtBottom, markChatSequenceRead, receiptsForChatMessage } from "./chat-panel-model";
import { uploadChatAttachment } from "./chat-file-upload";
import { describeChatUploadFile } from "./chat-upload-file";
import type { ChatMessage } from "./chat-types";

export type { ChatMessage } from "./chat-types";

export interface ChatPanelProps {
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onClose?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly title?: string;
  readonly variant?: "sidebar" | "mobile";
  readonly generatedAvatars?: boolean;
}

export const ChatPanelPresentation = React.memo((props: ChatPanelSurfaceProps): React.JSX.Element => {
  return <ChatPanelSurface {...props} />;
});

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

export interface ChatPanelSurfaceProps extends ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly pendingMessages?: SpaceSnapshot["chat"]["pendingSends"];
  readonly readReceipts?: readonly ChatReadReceipt[];
  readonly localReadThroughSequence?: string | null;
  readonly participantNames?: Readonly<Record<string, string>>;
  readonly onReact?: (input: ChatReactionInput) => Promise<unknown>;
  readonly onSendMessage?: (input: Pick<ChatSendInput, "text" | "attachments">) => Promise<void>;
  readonly onUploadAttachment?: (file: ChatUploadFile) => Promise<ChatAttachment>;
  readonly onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  readonly onMarkRead?: (throughSequence: string) => void | Promise<unknown>;
  readonly onLoadOlder?: () => Promise<void>;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly localParticipantId?: string;
  readonly error?: string | null;
  readonly messageDisplayTime?: (message: ChatMessage) => string;
  readonly autoScrollBehavior?: ScrollBehavior;
}

export const ChatPanelSurface = React.memo(
  ({
    messages,
    pendingMessages = [],
    readReceipts = [],
    localReadThroughSequence = null,
    participantNames = {},
    onSendMessage,
    onReact,
    onUploadAttachment,
    pickChatFiles,
    onResolveAttachmentUrl,
    onMarkRead,
    onRetryMessage,
    onLoadOlder,
    hasOlder = false,
    loadingOlder = false,
    localParticipantId,
    onClose,
    disabled = false,
    placeholder = "Message everyone",
    title = "Chat",
    variant = "sidebar",
    generatedAvatars = true,
    error,
    messageDisplayTime,
    autoScrollBehavior,
    className,
  }: ChatPanelSurfaceProps) => {
    const [draft, setDraft] = useState("");
    const [stagedFiles, setStagedFiles] = useState<readonly ChatUploadFile[]>([]);
    const uploads = useRef(new Map<ChatUploadFile, Promise<{ readonly attachment: ChatAttachment } | { readonly error: string }>>());
    const [failedUploads, setFailedUploads] = useState<ReadonlySet<ChatUploadFile>>(new Set());
    const [uploading, setUploading] = useState<ReadonlySet<ChatUploadFile>>(new Set());
    const [previews, setPreviews] = useState<ReadonlyMap<ChatUploadFile, string>>(new Map());
    // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing chat focus, scrolling, and media-query subscriptions.
    useEffect(() => {
      const urls = new Map(stagedFiles.flatMap((file) => (file instanceof File && file.type.startsWith("image/") ? [[file, URL.createObjectURL(file)] as const] : [])));
      setPreviews(urls);
      return () => {
        for (const url of urls.values()) URL.revokeObjectURL(url);
      };
    }, [stagedFiles]);
    const [sending, setSending] = useState(false);
    const [pickingFiles, setPickingFiles] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isAtBottomRef = useRef(true);
    const lastMarkedSequenceRef = useRef<string | null>(localReadThroughSequence);
    const restoreScrollRef = useRef<{
      readonly height: number;
      readonly top: number;
      readonly firstMessageId: string | undefined;
    } | null>(null);
    const grouped = useMemo(() => groupChatMessages(messages), [messages]);
    const latestSequence = messages.at(-1)?.sequence;
    useLayoutEffect(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const restore = restoreScrollRef.current;
      if (restore) {
        if (messages[0]?.messageId !== restore.firstMessageId) {
          scroller.scrollTop = restore.top + scroller.scrollHeight - restore.height;
        }
        restoreScrollRef.current = null;
        isAtBottomRef.current = isChatScrollAtBottom(scroller);
        return;
      }
      if (!isAtBottomRef.current) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: autoScrollBehavior ?? "auto" });
      if (latestSequence) markChatSequenceRead(latestSequence, lastMarkedSequenceRef, onMarkRead);
    }, [autoScrollBehavior, latestSequence, messages.length, onMarkRead, pendingMessages.length]);
    // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing chat focus, scrolling, and media-query subscriptions.
    useEffect(() => {
      if (!localReadThroughSequence) return;
      const previous = lastMarkedSequenceRef.current;
      if (!previous || compareChatSequence(localReadThroughSequence, previous) > 0) {
        lastMarkedSequenceRef.current = localReadThroughSequence;
      }
    }, [localReadThroughSequence]);
    // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing chat focus, scrolling, and media-query subscriptions.
    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }, [draft]);
    const startUpload = (file: ChatUploadFile) => {
      if (!onUploadAttachment) return undefined;
      setFailedUploads((current) => {
        const next = new Set(current);
        next.delete(file);
        return next;
      });
      setUploading((current) => new Set(current).add(file));
      const task: Promise<{ readonly attachment: ChatAttachment } | { readonly error: string }> = Promise.resolve()
        .then(() => onUploadAttachment(file))
        .then(
          (attachment) => ({ attachment }),
          (cause: unknown) => ({ error: cause instanceof Error ? cause.message : "Attachment could not be uploaded." }),
        )
        .then((result) => {
          if (uploads.current.get(file) !== task) return result;
          setUploading((current) => {
            const next = new Set(current);
            next.delete(file);
            return next;
          });
          if ("error" in result) {
            uploads.current.delete(file);
            setFailedUploads((current) => new Set(current).add(file));
            setComposerError(result.error);
          }
          return result;
        });
      uploads.current.set(file, task);
      return task;
    };
    const removeFile = (file: ChatUploadFile) => {
      uploads.current.delete(file);
      setUploading((current) => {
        const next = new Set(current);
        next.delete(file);
        return next;
      });
      setFailedUploads((current) => {
        const next = new Set(current);
        next.delete(file);
        return next;
      });
      setStagedFiles((current) => current.filter((candidate) => candidate !== file));
    };
    const send = async () => {
      const text = draft.trim();
      if ((!text && stagedFiles.length === 0) || !onSendMessage || disabled || sending || pickingFiles) return;
      setSending(true);
      setComposerError(null);
      try {
        const attachments: ChatAttachment[] = [];
        for (const file of stagedFiles) {
          const result = await (uploads.current.get(file) ?? startUpload(file));
          if (!result) throw new Error("This attachment is not ready. Remove it and attach it again.");
          if ("error" in result) throw new Error(result.error);
          attachments.push(result.attachment);
        }
        await onSendMessage({ text, attachments });
        setDraft("");
        setStagedFiles([]);
        uploads.current.clear();
        if (fileInputRef.current) fileInputRef.current.value = "";
      } catch (cause) {
        setComposerError(cause instanceof Error ? cause.message : "Message could not be sent.");
      } finally {
        setSending(false);
      }
    };
    const selectFiles = (files: FileList | readonly ChatUploadFile[] | null) => {
      if (!files) return;
      const selected: ChatUploadFile[] = Array.from(files);
      if (stagedFiles.length + selected.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) {
        setComposerError(`You can attach up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const invalid = selected.find((file) => {
        const { fileName, mimeType, byteLength } = describeChatUploadFile(file);
        const fileNameBytes = new TextEncoder().encode(fileName).byteLength;
        return !fileName || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength || fileNameBytes > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes || !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType);
      });
      if (invalid) {
        setComposerError(`${describeChatUploadFile(invalid).fileName} is not a supported chat attachment.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      for (const file of selected) startUpload(file);
      setStagedFiles((current) => [...current, ...selected]);
      setComposerError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    const chooseFiles = async () => {
      if (disabled || sending || pickingFiles) return;
      if (!pickChatFiles) {
        fileInputRef.current?.click();
        return;
      }
      setPickingFiles(true);
      setComposerError(null);
      try {
        selectFiles(await pickChatFiles());
      } catch (cause) {
        setComposerError(cause instanceof Error ? cause.message : "Could not read the selected files.");
      } finally {
        setPickingFiles(false);
      }
    };
    const loadOlder = async () => {
      const scroller = scrollRef.current;
      if (scroller) restoreScrollRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop, firstMessageId: messages[0]?.messageId };
      try {
        await onLoadOlder?.();
      } catch (cause) {
        restoreScrollRef.current = null;
        setComposerError(cause instanceof Error ? cause.message : "Earlier messages could not be loaded.");
      }
    };
    const scrollWork = useMemo(
      () =>
        createChatScrollWork({
          getScroller: () => scrollRef.current,
          getLatestSequence: () => messages.at(-1)?.sequence ?? null,
          lastMarkedSequenceRef,
          onMarkRead,
          onAtBottomChange: (atBottom) => {
            isAtBottomRef.current = atBottom;
          },
        }),
      [messages, onMarkRead],
    );
    // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing chat focus, scrolling, and media-query subscriptions.
    useEffect(() => () => scrollWork.dispose(), [scrollWork]);
    const handleScroll = scrollWork.onScroll;
    return (
      <div className={cn("relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-transparent text-[var(--chalk-app-text)]", className)} role="complementary" aria-label="Chat panel">
        <CallCardStyles />
        {variant === "sidebar" ? (
          <header className=" flex items-center justify-between border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] px-5 py-[18px]">
            <h2 className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-app-text)]">{title}</h2>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-full border border-[var(--chalk-app-line)] text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]"
                aria-label="Close chat"
              >
                <Cancel01Icon className="h-5 w-5" />
              </button>
            ) : null}
          </header>
        ) : null}

        <div ref={scrollRef} className="call-chat-messages" aria-label="Chat messages" aria-live="polite" onScroll={handleScroll}>
          {hasOlder && onLoadOlder ? (
            <Button variant="ghost" size="sm" className="mx-auto mb-3 flex" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </Button>
          ) : null}
          {messages.length === 0 && pendingMessages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <h3 className="mb-1 font-medium">No messages yet</h3>
              <p className="max-w-[220px] text-sm text-[var(--chalk-app-text-muted)]">Messages are seen by everyone in the call.</p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={`${group.participantId}-${group.firstMessageId}`}>
                {group.messages.map((message, index) => {
                  const isLocal = localParticipantId !== undefined && message.participantId === localParticipantId;
                  const readBy = isLocal ? receiptsForChatMessage(message.sequence, readReceipts, localParticipantId) : [];
                  return (
                    <div key={message.messageId} data-chat-sequence={message.sequence}>
                      <MessageBubble
                        content={message.text}
                        seed={message.messageId}
                        avatarSeed={message.participantId}
                        senderName={message.displayName}
                        timestamp={message.createdAt}
                        displayTime={messageDisplayTime?.(message)}
                        isLocal={isLocal}
                        isFirstInGroup={index === 0}
                        isLastInGroup={index === group.messages.length - 1}
                        showSender={index === 0}
                        showTimestamp={index === 0}
                        showAvatar
                        generatedAvatars={generatedAvatars}
                        status={readBy.length > 0 ? "read" : "sent"}
                        reactions={message.reactions}
                        localParticipantId={localParticipantId}
                        onReact={onReact ? (emoji, on) => onReact({ messageId: message.messageId, emoji, on }) : undefined}
                        attachments={message.attachments}
                        readBy={readBy}
                        participantNames={participantNames}
                        onResolveAttachmentUrl={onResolveAttachmentUrl}
                      />
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {pendingMessages.map((pending) => (
            <div key={pending.clientMessageId} className={pending.status === "queued" ? "my-2 opacity-70" : "my-2"}>
              <MessageBubble
                content={pending.text}
                seed={pending.clientMessageId}
                avatarSeed={localParticipantId}
                senderName={localParticipantId ? (participantNames[localParticipantId] ?? "You") : "You"}
                timestamp={new Date().toISOString()}
                isLocal
                status={pending.status === "queued" ? "queued" : "pending"}
                attachments={pending.attachments}
                generatedAvatars={generatedAvatars}
                onResolveAttachmentUrl={onResolveAttachmentUrl}
              />
              {pending.status === "queued" ? <p className="mr-14 text-right text-xs text-[var(--chalk-app-text-muted)]">Waiting to send</p> : null}
              {pending.status === "failed" ? (
                <div className="mr-14 flex items-center justify-end gap-2 text-xs text-[var(--chalk-app-text-muted)]">
                  <span>{pending.error?.message || "Not sent"}</span>
                  {onRetryMessage ? (
                    <button type="button" className="font-medium text-[var(--chalk-app-control-active-line)] hover:underline" onClick={() => void onRetryMessage(pending.clientMessageId)}>
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {(error || composerError) && (
          <p role="alert" className="mx-4 mb-2 rounded-lg bg-[var(--chalk-app-danger)]/10 px-3 py-2 text-sm text-[var(--chalk-app-danger)]">
            {composerError || error}
          </p>
        )}
        {stagedFiles.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t border-[var(--chalk-app-line)] px-4 pt-3" aria-label="Attachments">
            {stagedFiles.map((file, index) => (
              <div key={`${describeChatUploadFile(file).fileName}-${describeChatUploadFile(file).byteLength}-${index}`} className="call-staged-file">
                {previews.has(file) ? <img src={previews.get(file)} alt={`Preview of ${describeChatUploadFile(file).fileName}`} /> : null}
                <span>
                  <b>{describeChatUploadFile(file).fileName}</b>
                  <small>
                    {uploading.has(file) ? (
                      <span role="progressbar" aria-valuetext="Uploading" aria-label={`Uploading ${describeChatUploadFile(file).fileName}`}>
                        Uploading…
                      </span>
                    ) : failedUploads.has(file) ? (
                      "Upload failed · Send to retry"
                    ) : (
                      "Ready"
                    )}
                  </small>
                </span>
                <button type="button" disabled={sending || pickingFiles} aria-label={`Remove ${describeChatUploadFile(file).fileName}`} onClick={() => removeFile(file)}>
                  <Cancel01Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="call-composer">
          <div className="call-composer-field">
            {onUploadAttachment ? (
              <>
                {!pickChatFiles ? <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="Choose attachments" accept={CHALK_CHAT_ATTACHMENT_MIME_TYPES.join(",")} onChange={(event) => selectFiles(event.target.files)} /> : null}
                <Button type="button" variant="ghost" size="icon" className="call-attach-button" disabled={disabled || sending || pickingFiles || stagedFiles.length >= CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} onClick={() => void chooseFiles()} aria-label="Attach files">
                  <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20.5 11.2l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" />
                  </svg>
                </Button>
              </>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void send();
              }}
              placeholder={placeholder}
              disabled={disabled || sending}
              aria-label="Message"
              className="call-message-input"
              rows={1}
            />
            <Button type="button" size="icon" className="call-send-button" disabled={(!draft.trim() && stagedFiles.length === 0) || disabled || sending || pickingFiles} onClick={() => void send()} aria-label="Send message">
              <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

export const ChatPanel = React.memo((props: ChatPanelProps): React.JSX.Element => {
  const client = useSpaceClient();
  const canSendChat = useCan("sendChat");
  const chat = useChat();
  const participants = useParticipants();
  const self = useSelf();
  const localParticipantId = self.participantId ?? "local";
  const participantNames = useMemo(() => Object.fromEntries([...participants.roster.map((participant) => [participant.participantId, participant.displayName] as const), [localParticipantId, self.displayName ?? "You"]]), [localParticipantId, participants.roster, self.displayName]);
  return (
    <ChatPanelSurface
      {...props}
      disabled={props.disabled || !canSendChat}
      messages={chat.messages}
      onReact={canSendChat ? chat.react : undefined}
      pendingMessages={chat.pendingSends}
      readReceipts={chat.readReceipts}
      participantNames={participantNames}
      localParticipantId={localParticipantId}
      hasOlder={chat.pagination.hasOlder}
      onSendMessage={canSendChat ? (input) => client.chat.send(input).then(() => undefined) : undefined}
      onUploadAttachment={canSendChat ? (file) => uploadChatAttachment(file, client.chat.files) : undefined}
      onResolveAttachmentUrl={async (attachmentId) => {
        const attachment = [...chat.messages, ...chat.pendingSends].flatMap((message) => message.attachments).find((candidate) => candidate.attachmentId === attachmentId);
        if (!attachment) throw new Error("The chat attachment is no longer available.");
        return client.chat.files.resolveUrl(attachment);
      }}
      onMarkRead={(sequence) => {
        const message = chat.messages.find((candidate) => candidate.sequence === sequence);
        return message ? client.chat.markRead(message.messageId) : undefined;
      }}
      onLoadOlder={() => client.chat.loadOlder().then(() => undefined)}
      error={chat.lastError?.message ?? null}
    />
  );
});

ChatPanel.displayName = "ChatPanel";
