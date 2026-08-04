import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES } from "../../client-compat";
import type { ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, SpacePendingChatSend } from "../../client-compat";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../utils/cn";
import { Cancel01Icon, Message01Icon, SentIcon, Upload01Icon } from "../../utils/icons";
import { Button } from "@q9labsai/chalk-ui";
import { MessageBubble } from "./MessageBubble";
import { compareChatSequence, groupChatMessages, isChatScrollAtBottom, latestVisibleChatSequence, markChatSequenceRead, receiptsForChatMessage } from "./chat-panel-model";

export type { ChatMessage } from "./chat-types";

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);
export interface ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly pendingMessages?: readonly SpacePendingChatSend[];
  readonly readReceipts?: readonly ChatReadReceipt[];
  readonly localReadThroughSequence?: string | null;
  readonly participantNames?: Readonly<Record<string, string>>;
  readonly onSendMessage: (input: Pick<ChatSendInput, "text" | "attachments">) => Promise<void>;
  readonly onUploadAttachment?: (file: File) => Promise<ChatAttachment>;
  readonly onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  readonly onMarkRead?: (throughSequence: string) => void | Promise<unknown>;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onLoadOlder?: () => Promise<void>;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly localParticipantId?: string;
  readonly onClose?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly title?: string;
  readonly variant?: "sidebar" | "mobile";
  readonly error?: string | null;
}

export const ChatPanel = React.memo(
  ({
    messages,
    pendingMessages = [],
    readReceipts = [],
    localReadThroughSequence = null,
    participantNames = {},
    onSendMessage,
    onUploadAttachment,
    onResolveAttachmentUrl,
    onMarkRead,
    onRetryMessage,
    onLoadOlder,
    hasOlder = false,
    loadingOlder = false,
    localParticipantId,
    onClose,
    disabled = false,
    placeholder = "Type a message...",
    title = "Chat",
    variant = "sidebar",
    error,
    className,
  }: ChatPanelProps) => {
    const [draft, setDraft] = useState("");
    const [stagedFiles, setStagedFiles] = useState<readonly File[]>([]);
    const [sending, setSending] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isAtBottomRef = useRef(true);
    const mountedRef = useRef(false);
    const lastMarkedSequenceRef = useRef<string | null>(localReadThroughSequence);
    const restoreScrollRef = useRef<{ readonly height: number; readonly top: number; readonly firstMessageId: string | undefined } | null>(null);
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
      scroller.scrollTop = scroller.scrollHeight;
      endRef.current?.scrollIntoView?.({ behavior: mountedRef.current ? "smooth" : "auto", block: "end" });
      if (latestSequence) markChatSequenceRead(latestSequence, lastMarkedSequenceRef, onMarkRead);
      mountedRef.current = true;
    }, [latestSequence, messages.length, onMarkRead, pendingMessages.length]);

    useEffect(() => {
      if (!localReadThroughSequence) return;
      const previous = lastMarkedSequenceRef.current;
      if (!previous || compareChatSequence(localReadThroughSequence, previous) > 0) {
        lastMarkedSequenceRef.current = localReadThroughSequence;
      }
    }, [localReadThroughSequence]);

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }, [draft]);

    const send = async () => {
      const text = draft.trim();
      if ((!text && stagedFiles.length === 0) || disabled || sending) return;
      setSending(true);
      setComposerError(null);
      try {
        const attachments = onUploadAttachment ? await Promise.all(stagedFiles.map((file) => onUploadAttachment(file))) : [];
        await onSendMessage({ text, attachments });
        setDraft("");
        setStagedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
      } catch (cause) {
        setComposerError(cause instanceof Error ? cause.message : "Message could not be sent.");
      } finally {
        setSending(false);
      }
    };

    const selectFiles = (files: FileList | null) => {
      if (!files) return;
      const selected = Array.from(files);
      if (stagedFiles.length + selected.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) {
        setComposerError(`You can attach up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const invalid = selected.find((file) => !ALLOWED_ATTACHMENT_MIME_TYPES.has(file.type) || file.size > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength || new TextEncoder().encode(file.name).byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes);
      if (invalid) {
        setComposerError(`${invalid.name} is not a supported chat attachment.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setStagedFiles((current) => [...current, ...selected]);
      setComposerError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

    const handleScroll = () => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const atBottom = isChatScrollAtBottom(scroller);
      isAtBottomRef.current = atBottom;
      if (atBottom) {
        if (latestSequence) markChatSequenceRead(latestSequence, lastMarkedSequenceRef, onMarkRead);
        return;
      }
      const visibleSequence = latestVisibleChatSequence(scroller);
      if (visibleSequence) markChatSequenceRead(visibleSequence, lastMarkedSequenceRef, onMarkRead);
    };

    return (
      <div className={cn("relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-transparent text-card-foreground", variant !== "mobile" && "animate-in slide-in-from-right-5 duration-300", className)} role="complementary" aria-label="Chat panel">
        {variant === "sidebar" ? (
          <header className="chalk-textured-surface flex items-center justify-between border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] px-5 py-[18px]">
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

        <div ref={scrollRef} className="chalk-textured-surface flex-1 overflow-y-auto bg-[var(--chalk-app-panel)] px-2 py-5" aria-label="Chat messages" aria-live="polite" onScroll={handleScroll}>
          {hasOlder && onLoadOlder ? (
            <Button variant="ghost" size="sm" className="mx-auto mb-3 flex" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </Button>
          ) : null}
          {messages.length === 0 && pendingMessages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Message01Icon className="h-8 w-8" />
              </div>
              <h3 className="mb-1 font-medium">No messages yet</h3>
              <p className="max-w-[220px] text-sm text-muted-foreground">Send a message to start the conversation.</p>
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
                        senderName={message.displayName}
                        timestamp={message.createdAt}
                        isLocal={isLocal}
                        isFirstInGroup={index === 0}
                        isLastInGroup={index === group.messages.length - 1}
                        showSender={index === 0}
                        showTimestamp={index === group.messages.length - 1}
                        showAvatar
                        status={readBy.length > 0 ? "read" : "sent"}
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
            <div key={pending.clientMessageId} className="my-2">
              <MessageBubble content={pending.text} senderName={localParticipantId ? (participantNames[localParticipantId] ?? "You") : "You"} timestamp={new Date().toISOString()} isLocal status="pending" attachments={pending.attachments} onResolveAttachmentUrl={onResolveAttachmentUrl} />
              {pending.status === "failed" ? (
                <div className="mr-14 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                  <span>{pending.error?.message || "Not sent"}</span>
                  {onRetryMessage ? (
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => void onRetryMessage(pending.clientMessageId)}>
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {(error || composerError) && (
          <p role="alert" className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {composerError || error}
          </p>
        )}
        {stagedFiles.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t border-border/30 px-4 pt-3" aria-label="Attachments">
            {stagedFiles.map((file, index) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="flex max-w-full items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs">
                <span className="max-w-52 truncate">{file.name}</span>
                <button type="button" disabled={sending} aria-label={`Remove ${file.name}`} onClick={() => setStagedFiles((current) => current.filter((_, candidate) => candidate !== index))}>
                  <Cancel01Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="chalk-textured-surface flex items-end gap-2 border-t border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] px-4 py-4">
          {onUploadAttachment ? (
            <>
              <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="Choose attachments" onChange={(event) => selectFiles(event.target.files)} />
              <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-full" disabled={disabled || sending || stagedFiles.length >= CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} onClick={() => fileInputRef.current?.click()} aria-label="Attach files">
                <Upload01Icon className="h-5 w-5" />
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
            className="min-h-11 max-h-[120px] flex-1 resize-none rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-input)] px-3.5 py-3 text-sm text-[var(--chalk-app-text)] outline-none transition placeholder:text-[var(--chalk-app-text-muted)] focus:border-[var(--chalk-app-control-active-line)]"
            rows={1}
          />
          <Button
            type="button"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-[8px] bg-[var(--chalk-app-control-primary)] !text-white hover:bg-[var(--chalk-app-control-primary-hover)]"
            disabled={(!draft.trim() && stagedFiles.length === 0) || disabled || sending}
            onClick={() => void send()}
            aria-label="Send message"
          >
            <SentIcon className="h-5 w-5" />
          </Button>
        </div>
      </div>
    );
  },
);

ChatPanel.displayName = "ChatPanel";
