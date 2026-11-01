import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatAttachment, type ChatMessage, type ChatUploadFile, type PendingChatSend } from "@q9labsai/chalk-client";

export type FileKind = "image" | "pdf" | "doc" | "xls" | "ppt" | "txt" | "other";

const KIND_BY_MIME: Readonly<Record<string, FileKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
  "application/vnd.oasis.opendocument.text": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt",
  "application/vnd.oasis.opendocument.presentation": "ppt",
};

export function fileKind(mimeType: string): FileKind {
  return KIND_BY_MIME[mimeType] ?? "other";
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
};

/** The MIME type a picked file reports, or the one its extension implies when the picker reports none. */
export function mimeTypeOf(name: string, reported: string | undefined): string {
  if (reported) return reported;
  const dot = name.lastIndexOf(".");
  return (dot > 0 && MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/** The two or three letters on a file badge (`.fi`). */
export const FILE_BADGE: Readonly<Record<Exclude<FileKind, "image">, string>> = { pdf: "PDF", doc: "DOC", xls: "XLS", ppt: "PPT", txt: "TXT", other: "FILE" };

const MB = 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** What a message row shows for a sent, waiting or failed message. */
export type EntryState = "sent" | "queued" | "sending" | "failed";

export type ChatEntry = {
  readonly key: string;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly state: EntryState;
  /** Set on pending sends, so a failed one can be sent again. */
  readonly clientMessageId: string | null;
};

export type MessageGroup = {
  readonly key: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly mine: boolean;
  readonly time: string;
  readonly entries: readonly ChatEntry[];
};

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Whether a message with only attachments should read as "Sent a photo" and so on, for announcements and labels. */
export function messageSummary(text: string, attachments: readonly ChatAttachment[]): string {
  if (text) return text;
  const count = attachments.length;
  if (count === 0) return "";
  const photos = attachments.filter((attachment) => fileKind(attachment.mimeType) === "image").length;
  if (photos === count) return count > 1 ? `Sent ${count} photos` : "Sent a photo";
  return count > 1 ? `Sent ${count} files` : "Sent a file";
}

/**
 * Turns the client's confirmed messages and your waiting sends into rows, oldest first: consecutive
 * messages from one person share a header (`.mg`). A send you retried leaves its failed copy in the
 * client, so `retried` hides those.
 */
export function groupMessages(messages: readonly ChatMessage[], pending: readonly PendingChatSend[], self: { readonly participantId: string | null; readonly displayName: string | null }, retried: ReadonlySet<string>): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];
  const add = (participantId: string, displayName: string, time: string, entry: ChatEntry) => {
    const last = groups[groups.length - 1];
    if (last && last.participantId === participantId) {
      groups[groups.length - 1] = { ...last, entries: [...last.entries, entry] };
      return;
    }
    groups.push({ key: entry.key, participantId, displayName, mine: participantId === self.participantId, time, entries: [entry] });
  };
  for (const message of messages) {
    add(message.participantId, message.displayName, formatTime(message.createdAt), { key: message.messageId, text: message.text, attachments: message.attachments, state: "sent", clientMessageId: null });
  }
  for (const send of pending) {
    if (retried.has(send.clientMessageId)) continue;
    add(self.participantId ?? "self", self.displayName ?? "You", "Now", { key: send.clientMessageId, text: send.text, attachments: send.attachments, state: send.status === "failed" ? "failed" : send.status === "queued" ? "queued" : "sending", clientMessageId: send.clientMessageId });
  }
  return groups;
}

/** A file the person picked, on its way to being sent. */
export type StagedFile = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly source: ChatUploadFile;
  /** The local photo to show in the chip, before it's uploaded. */
  readonly previewUri: string | null;
  readonly state: "uploading" | "ready" | "error";
  readonly attachment: ChatAttachment | null;
  readonly error: string | null;
};

export type UploadFacts = { readonly name: string; readonly mimeType: string; readonly size: number };

const allowedMimeTypes = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

/** The reason a file can't be sent, or null. `accepted` counts the files already accepted in this message. */
export function stagingError(facts: UploadFacts, accepted: number): string | null {
  if (!allowedMimeTypes.has(facts.mimeType)) {
    const dot = facts.name.lastIndexOf(".");
    return dot > 0 && dot < facts.name.length - 1 ? `Can’t send .${facts.name.slice(dot + 1).toLowerCase()} files` : "Can’t send this type of file";
  }
  if (facts.size > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "Over the 25 MB limit";
  if (accepted >= CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) return `Only ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files per message`;
  return null;
}

/** How many photos of a message the thumbnail grid draws, and how many are left over for "+N". */
export function thumbnailLayout(count: number): { readonly shown: number; readonly more: number } {
  return { shown: Math.min(count, 4), more: Math.max(0, count - 4) };
}
