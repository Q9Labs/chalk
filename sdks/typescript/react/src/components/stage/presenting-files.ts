import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatUploadFile, type SpaceClient } from "@q9labsai/chalk-client";
import { describeChatUploadFile } from "../composite/chat-upload-file";

export const PRESENTABLE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The file picker's accept list: the same types the Stage can present. */
export const PRESENTABLE_ACCEPT = [...PRESENTABLE_MIME_TYPES].join(",");

/** "PDF or image, up to 25 MB", derived from the presentable types so a new type widens the copy without a UI change. */
export function presentableFilesHint(): string {
  const kinds = [...new Set([...PRESENTABLE_MIME_TYPES].map((type) => (type === "application/pdf" ? "PDF" : (type.split("/")[0] ?? type))))];
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1)}` : (kinds[0] ?? "File");
  return `${list}, up to ${Math.round(CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength / (1024 * 1024))} MB`;
}

export function chatAcceptsFile(file: ChatUploadFile): boolean {
  return (CHALK_CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(describeChatUploadFile(file).mimeType);
}

export type PresentingFileFailure = { readonly fileName: string; readonly reason: "unsupported" | "too_big" | "failed" | "empty" };
export type PresentingFileResult = {
  readonly presented?: string;
  /** The Stage candidate when presenting it failed, kept so the presenter can retry it or send it to chat themselves. */
  readonly stageFailure?: { readonly file: ChatUploadFile; readonly failure: PresentingFileFailure };
  readonly chatFiles: readonly ChatUploadFile[];
  readonly failures: readonly PresentingFileFailure[];
  readonly chatOverflow: number;
};

export type PresentingFileSplit = {
  readonly stageFile?: ChatUploadFile;
  readonly chatFiles: readonly ChatUploadFile[];
  readonly failures: readonly PresentingFileFailure[];
  readonly chatOverflow: number;
};

export function presentingFileProblem(file: ChatUploadFile): "unsupported" | "too_big" | "empty" | null {
  const description = describeChatUploadFile(file);
  if (description.byteLength === 0) return "empty";
  if (description.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "too_big";
  return PRESENTABLE_MIME_TYPES.has(description.mimeType) ? null : "unsupported";
}

/** Splits dropped or chosen files into the first Stage candidate, files chat can carry, and files neither accepts. */
export function splitPresentingFiles(files: readonly ChatUploadFile[], options: { readonly presentingAvailable?: boolean; readonly chatEnabled?: boolean } = {}): PresentingFileSplit {
  const presentingAvailable = options.presentingAvailable !== false;
  const chatEnabled = options.chatEnabled !== false;
  const failures: PresentingFileFailure[] = [];
  const chatFiles: ChatUploadFile[] = [];
  let stageFile: ChatUploadFile | undefined;
  for (const file of files) {
    const description = describeChatUploadFile(file);
    if (description.byteLength === 0) {
      failures.push({ fileName: description.fileName, reason: "empty" });
      continue;
    }
    if (description.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) {
      failures.push({ fileName: description.fileName, reason: "too_big" });
      continue;
    }
    if (presentingAvailable && !stageFile && PRESENTABLE_MIME_TYPES.has(description.mimeType)) {
      stageFile = file;
      continue;
    }
    if (chatEnabled && chatAcceptsFile(file)) chatFiles.push(file);
    else failures.push({ fileName: description.fileName, reason: "unsupported" });
  }
  return { stageFile, ...limitComposerFiles(chatFiles), failures };
}

function limitComposerFiles(files: readonly ChatUploadFile[]): { readonly chatFiles: readonly ChatUploadFile[]; readonly chatOverflow: number } {
  const chatFiles = files.slice(0, CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage);
  return { chatFiles, chatOverflow: files.length - chatFiles.length };
}

export type PresentFilesOptions = {
  readonly presentingAvailable?: boolean;
  readonly chatEnabled?: boolean;
  /** Called as soon as a Stage candidate is found, before any bytes move, so the Stage can acknowledge the file at once. */
  readonly onStageFile?: (fileName: string) => void;
  readonly onProgress?: (fraction: number) => void;
};

/**
 * Attempts the Stage candidate and returns the other sendable files, which wait in the composer instead of being sent.
 * A Stage candidate that fails comes back on its own and is never staged in chat: the presenter decides what happens to it.
 */
export async function presentFiles(files: readonly ChatUploadFile[], client: SpaceClient, options: PresentFilesOptions = {}): Promise<PresentingFileResult> {
  const { stageFile, chatFiles, chatOverflow, failures } = splitPresentingFiles(files, options);
  if (!stageFile) return { chatFiles, chatOverflow, failures };
  const fileName = describeChatUploadFile(stageFile).fileName;
  options.onStageFile?.(fileName);
  try {
    const attachment = await client.chat.files.upload(stageFile, { onProgress: options.onProgress });
    const result = await client.presenting.present(attachment.attachmentId);
    if (result.kind === "accepted") return { presented: fileName, chatFiles, chatOverflow, failures };
  } catch {
    // The upload or the present command failed; both read as this file's failure below.
  }
  return { stageFailure: { file: stageFile, failure: { fileName, reason: "failed" } }, chatFiles, chatOverflow, failures };
}
