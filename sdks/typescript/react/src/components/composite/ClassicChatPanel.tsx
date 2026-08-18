import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES } from "@q9labsai/chalk-client";
import type { ChatAttachment, ChatReadReceipt, ChatSendInput, ChatUploadFile, SpaceSnapshot } from "@q9labsai/chalk-client";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";

import { cn } from "../../utils/cn";
import { Cancel01Icon, Message01Icon, SentIcon, Upload01Icon } from "../../utils/icons";
import { Button } from "@q9labsai/chalk-ui";
import { MessageBubble } from "./MessageBubble";
import { compareChatSequence, groupChatMessages, isChatScrollAtBottom, latestVisibleChatSequence, markChatSequenceRead, receiptsForChatMessage } from "./chat-panel-model";
import { uploadChatAttachment } from "./chat-file-upload";
import type { ChatMessage } from "./chat-types";
import type { ChatPanelProps } from "./ChatPanel";

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

interface ChatPanelSurfaceProps extends ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly pendingMessages?: SpaceSnapshot["chat"]["pendingSends"];
  readonly readReceipts?: readonly ChatReadReceipt[];
  readonly localReadThroughSequence?: string | null;
  readonly participantNames?: Readonly<Record<string, string>>;
  readonly onSendMessage: (input: Pick<ChatSendInput, "text" | "attachments">) => Promise<void>;
  readonly onUploadAttachment?: (file: ChatUploadFile) => Promise<ChatAttachment>;
  readonly onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  readonly onMarkRead?: (throughSequence: string) => void | Promise<unknown>;
  readonly onLoadOlder?: () => Promise<void>;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly localParticipantId?: string;
  readonly error?: string | null;
}

const ChatPanelSurface = React.memo(
  ({
    messages,
    pendingMessages = [],
    readReceipts = [],
    localReadThroughSequence = null,
    participantNames = {},
    onSendMessage,
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
    placeholder = "Type a message...",
    title = "Chat",
    variant = "sidebar",
    error,
    className,
  }: ChatPanelSurfaceProps) => {
    const [draft, setDraft] = useState("");
    const [stagedFiles, setStagedFiles] = useState<readonly ChatUploadFile[]>([]);
    const [sending, setSending] = useState(false);
    const [pickingFiles, setPickingFiles] = useState(false);
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
      if ((!text && stagedFiles.length === 0) || disabled || sending || pickingFiles) return;
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

    const selectFiles = (files: FileList | readonly ChatUploadFile[] | null) => {
      if (!files) return;
      const selected = Array.from(files) as ChatUploadFile[];
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
      <div className={cn("relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-transparent text-[var(--chalk-app-text)]", variant !== "mobile" && "animate-in slide-in-from-right-5 duration-300", className)} role="complementary" aria-label="Chat panel">
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
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]">
                <Message01Icon className="h-8 w-8" />
              </div>
              <h3 className="mb-1 font-medium">No messages yet</h3>
              <p className="max-w-[220px] text-sm text-[var(--chalk-app-text-muted)]">Send a message to start the conversation.</p>
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
          <div ref={endRef} />
        </div>

        {(error || composerError) && (
          <p role="alert" className="mx-4 mb-2 rounded-lg bg-[var(--chalk-app-danger)]/10 px-3 py-2 text-sm text-[var(--chalk-app-danger)]">
            {composerError || error}
          </p>
        )}
        {stagedFiles.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t border-[var(--chalk-app-line)] px-4 pt-3" aria-label="Attachments">
            {stagedFiles.map((file, index) => (
              <div key={`${describeChatUploadFile(file).fileName}-${describeChatUploadFile(file).byteLength}-${index}`} className="flex max-w-full items-center gap-2 rounded-full bg-[var(--chalk-app-control-group)] px-3 py-1.5 text-xs">
                <span className="max-w-52 truncate">{describeChatUploadFile(file).fileName}</span>
                <button type="button" disabled={sending || pickingFiles} aria-label={`Remove ${describeChatUploadFile(file).fileName}`} onClick={() => setStagedFiles((current) => current.filter((_, candidate) => candidate !== index))}>
                  <Cancel01Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="chalk-textured-surface flex items-end gap-2 border-t border-[var(--chalk-app-line)] bg-[var(--chalk-app-chrome)] px-4 py-4">
          {onUploadAttachment ? (
            <>
              {!pickChatFiles ? <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="Choose attachments" onChange={(event) => selectFiles(event.target.files)} /> : null}
              <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-full" disabled={disabled || sending || pickingFiles || stagedFiles.length >= CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} onClick={() => void chooseFiles()} aria-label="Attach files">
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
            disabled={(!draft.trim() && stagedFiles.length === 0) || disabled || sending || pickingFiles}
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

export const ClassicChatPanel = React.memo((props: ChatPanelProps): React.JSX.Element => {
  const client = useSpaceClient();
  const chat = useChat();
  const participants = useParticipants();
  const self = useSelf();
  const localParticipantId = self.participantId ?? "local";
  const participantNames = useMemo(() => Object.fromEntries([...participants.roster.map((participant) => [participant.participantId, participant.displayName] as const), [localParticipantId, self.displayName ?? "You"]]), [localParticipantId, participants.roster, self.displayName]);

  return (
    <ChatPanelSurface
      {...props}
      messages={chat.messages}
      pendingMessages={chat.pendingSends}
      readReceipts={chat.readReceipts}
      participantNames={participantNames}
      localParticipantId={localParticipantId}
      hasOlder={chat.pagination.hasOlder}
      onSendMessage={(input) => client.chat.send(input).then(() => undefined)}
      onUploadAttachment={(file) => uploadChatAttachment(file, client.chat.files)}
      onResolveAttachmentUrl={async (attachmentId) => {
        const attachment = [...chat.messages, ...chat.pendingSends].flatMap((message) => message.attachments).find((candidate) => candidate.attachmentId === attachmentId);
        if (!attachment) throw new Error("The chat attachment is no longer available.");
        return client.chat.files.url(attachment);
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

ClassicChatPanel.displayName = "ChatPanel";

function describeChatUploadFile(file: ChatUploadFile): { readonly fileName: string; readonly mimeType: string; readonly byteLength: number } {
  if ("bytes" in file) return { fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
  return { fileName: file.name, mimeType: file.type, byteLength: file.size };
}
