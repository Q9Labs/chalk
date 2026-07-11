import React, { useEffect, useRef, useState, useMemo } from "react";
import { Message01Icon, SentIcon, PlusSignIcon, CancelCircleIcon, Cancel01Icon, FileTextIcon } from "../../utils/icons";
import { MessageBubble } from "./MessageBubble";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { Button } from "../ui";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import type { ChatAttachment, ChatMessage, ChatReadReceipt } from "./chat-types";

export type { ChatAttachment, ChatMessage, ChatReadReceipt };

export interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onSendMessageWithAttachments?: (content: string, files: File[]) => void;
  onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  localParticipantId?: string;
  onClose?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  /** Variant for different layouts */
  variant?: "sidebar" | "mobile";
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

// Group messages by sender within a time window (2 minutes)
const groupMessages = (messages: ChatMessage[]) => {
  const groups: { messages: ChatMessage[]; senderId: string }[] = [];
  const TIME_WINDOW = 2 * 60 * 1000; // 2 minutes

  messages.forEach((msg) => {
    const lastGroup = groups[groups.length - 1];
    const lastMsg = lastGroup?.messages[lastGroup.messages.length - 1];

    // Check if this message belongs to the same group
    const isSameSender = lastGroup && lastGroup.senderId === msg.senderId;
    const isWithinTimeWindow = lastMsg && new Date(msg.timestamp).getTime() - new Date(lastMsg.timestamp).getTime() < TIME_WINDOW;

    if (isSameSender && isWithinTimeWindow) {
      lastGroup.messages.push(msg);
    } else {
      groups.push({ messages: [msg], senderId: msg.senderId });
    }
  });

  return groups;
};

export const ChatPanel = React.memo(
  ({ messages, onSendMessage, onSendMessageWithAttachments, onResolveAttachmentUrl, localParticipantId, onClose, disabled = false, placeholder = "Type a message...", title = "Chat", variant = "sidebar", participantColorSeed, participantGradientPreference, className }: ChatPanelProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [inputValue, setInputValue] = useState("");
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const [isAtBottom, setIsAtBottom] = useState(true);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

    const messageGroups = useMemo(() => groupMessages(messages), [messages]);

    const scrollToBottom = (smooth = true) => {
      messagesEndRef.current?.scrollIntoView({
        behavior: smooth && !prefersReducedMotion ? "smooth" : "auto",
      });
    };

    useEffect(() => {
      if (isAtBottom) {
        scrollToBottom();
      }
    }, [messages, isAtBottom]);

    // Grow the composer with its content, up to its max height
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, [inputValue]);

    const handleScroll = () => {
      if (!messagesContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
    };

    const handleSend = async () => {
      const trimmedContent = inputValue.trim();
      const hasFiles = selectedFiles.length > 0;

      if ((trimmedContent || hasFiles) && !disabled && !uploading) {
        if (hasFiles && onSendMessageWithAttachments) {
          try {
            setUploading(true);
            await onSendMessageWithAttachments(trimmedContent, selectedFiles);
            setInputValue("");
            setSelectedFiles([]);
            setAttachmentError(null);
          } catch (error) {
            setAttachmentError(error instanceof Error ? error.message : "Failed to upload files. Please try again.");
          } finally {
            setUploading(false);
          }
        } else {
          onSendMessage(trimmedContent);
          setInputValue("");
        }
        setTimeout(() => scrollToBottom(), 100);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      const validFiles: File[] = [];
      const oversizedFiles: string[] = [];

      files.forEach((file) => {
        if (file.size > MAX_FILE_SIZE) {
          oversizedFiles.push(file.name);
        } else {
          validFiles.push(file);
        }
      });

      if (oversizedFiles.length > 0) {
        const fileLabel = oversizedFiles.map((name) => `"${name}"`).join(", ");
        setAttachmentError(`${fileLabel} ${oversizedFiles.length === 1 ? "exceeds" : "exceed"} the max 25 MB per file limit.`);
      } else {
        setAttachmentError(null);
      }

      setSelectedFiles((prev) => [...prev, ...validFiles]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const removeFile = (index: number) => {
      setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
      if (selectedFiles.length === 1) {
        setAttachmentError(null);
      }
    };

    return (
      <div
        className={cn("relative flex h-full min-h-0 w-full flex-col overflow-hidden", "bg-transparent text-card-foreground", !prefersReducedMotion && variant !== "mobile" && "animate-in slide-in-from-right-5 duration-300", className)}
        data-tour="chat-panel"
        role="complementary"
        aria-label="Chat panel"
        style={themeVariables as React.CSSProperties}
      >
        {variant === "sidebar" && (
          <div className="flex items-center justify-between px-6 py-5">
            <h2 className="text-2xl font-bold text-card-foreground">{title}</h2>
            <div className="flex items-center gap-2">
              {onClose && (
                <button type="button" onClick={onClose} className="flex items-center justify-center w-8 h-8 rounded-full transition-colors hover:bg-muted text-muted-foreground hover:text-foreground" aria-label="Close chat">
                  <Cancel01Icon size={20} />
                </button>
              )}
            </div>
          </div>
        )}

        <div ref={messagesContainerRef} onScroll={handleScroll} className={cn("flex-1 overflow-y-auto py-4", "[scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]")}>
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-primary/10 text-primary">
                <Message01Icon className="w-8 h-8" />
              </div>
              <h3 className="font-medium mb-1 text-card-foreground">No messages yet</h3>
              <p className="text-sm max-w-[200px] text-muted-foreground">Send a message to start the conversation</p>
            </div>
          ) : (
            <div>
              {messageGroups.map((group, groupIndex) => (
                <div key={`group-${groupIndex}`}>
                  {group.messages.map((msg, msgIndex) => {
                    const isLocalMessage = msg.isLocal ?? (localParticipantId !== undefined && msg.senderId === localParticipantId);

                    return (
                      <MessageBubble
                        key={msg.id}
                        content={msg.content}
                        senderName={msg.senderName}
                        timestamp={msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)}
                        isLocal={isLocalMessage}
                        isFirstInGroup={msgIndex === 0}
                        isLastInGroup={msgIndex === group.messages.length - 1}
                        showSender={msgIndex === 0}
                        showTimestamp={msgIndex === group.messages.length - 1}
                        showAvatar={true}
                        attachments={msg.attachments}
                        readBy={msg.readBy}
                        onResolveAttachmentUrl={onResolveAttachmentUrl}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div ref={messagesEndRef} className="h-1" />
        </div>

        {!isAtBottom && messages.length > 0 && (
          <Button onClick={() => scrollToBottom()} size="sm" className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg">
            Jump to latest
          </Button>
        )}

        <div className="px-6 py-5 border-t border-border/30">
          {/* Attachment Tray */}
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {selectedFiles.map((file, index) => {
                const isImage = file.type.startsWith("image/");
                return (
                  <div key={`${file.name}-${index}`} className="relative group">
                    <div className={cn("flex items-center gap-2 p-2 rounded-xl border bg-muted/30 border-border/50", isImage ? "pr-3" : "px-3")}>
                      {isImage ? (
                        <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 border border-border/30">
                          <img src={URL.createObjectURL(file)} alt="preview" className="w-full h-full object-cover" onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)} />
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary shrink-0">
                          <FileTextIcon className="w-5 h-5" />
                        </div>
                      )}
                      <div className="max-w-[120px]">
                        <p className="text-xs font-medium truncate">{file.name}</p>
                        <p className="text-[10px] text-muted-foreground">{formatFileSize(file.size)}</p>
                      </div>
                    </div>
                    <button type="button" onClick={() => removeFile(index)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-md hover:scale-110 transition-transform">
                      <CancelCircleIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {attachmentError && (
            <div className="mb-3 p-2 px-3 rounded-lg bg-destructive/10 text-destructive text-[11px] font-medium animate-in fade-in duration-200" role="alert">
              {attachmentError}
            </div>
          )}

          <div className="flex items-center gap-3">
            <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple />
            <Button variant="ghost" size="icon" onClick={() => fileInputRef.current?.click()} className="flex-shrink-0 w-11 h-11 rounded-full bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted/80" aria-label="Add attachment">
              <PlusSignIcon className="w-5 h-5" />
            </Button>

            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder || "Write message..."}
                disabled={disabled || uploading}
                aria-label="Message"
                className={cn("w-full py-3 px-5 resize-none outline-none rounded-2xl text-sm", "bg-muted/50", "text-foreground", "placeholder:text-muted-foreground", "focus:ring-2 focus:ring-primary/50 focus:bg-muted/70", "transition-all")}
                style={{ minHeight: "44px", maxHeight: "120px" }}
                rows={1}
              />
            </div>

            <Button
              onClick={handleSend}
              disabled={(!inputValue.trim() && selectedFiles.length === 0) || disabled || uploading}
              size="icon"
              className={cn("flex-shrink-0 w-11 h-11 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25", uploading && "opacity-70 cursor-not-allowed")}
              aria-label="Send message"
            >
              {uploading ? <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" /> : <SentIcon className="w-5 h-5 ml-0.5" />}
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

ChatPanel.displayName = "ChatPanel";
