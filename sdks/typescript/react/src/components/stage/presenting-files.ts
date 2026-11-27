import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatUploadFile, type SpaceClient } from "@q9labsai/chalk-client";
import { describeChatUploadFile } from "../composite/chat-upload-file";

export const PRESENTABLE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PresentingFileFailure = { readonly fileName: string; readonly reason: "unsupported" | "too_big" | "failed" | "empty" };
export type PresentingFileResult = {
  readonly presented?: string;
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
    if (chatEnabled && (CHALK_CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(description.mimeType)) chatFiles.push(file);
    else failures.push({ fileName: description.fileName, reason: "unsupported" });
  }
  return { stageFile, ...limitComposerFiles(chatFiles), failures };
}

function limitComposerFiles(files: readonly ChatUploadFile[]): { readonly chatFiles: readonly ChatUploadFile[]; readonly chatOverflow: number } {
  const chatFiles = files.slice(0, CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage);
  return { chatFiles, chatOverflow: files.length - chatFiles.length };
}

/** Attempts the Stage candidate and returns every sendable file that must be staged in the composer instead of sent. */
export async function presentFiles(files: readonly ChatUploadFile[], client: SpaceClient, options: { readonly presentingAvailable?: boolean; readonly chatEnabled?: boolean } = {}): Promise<PresentingFileResult> {
  const { stageFile, chatFiles: splitChatFiles, chatOverflow: splitOverflow, failures: splitFailures } = splitPresentingFiles(files, options);
  const failures: PresentingFileFailure[] = [...splitFailures];
  const chatFiles = [...splitChatFiles];
  let presented: string | undefined;
  if (stageFile) {
    try {
      const attachment = await client.chat.files.upload(stageFile);
      const result = await client.presenting.present(attachment.attachmentId);
      if (result.kind === "accepted") presented = describeChatUploadFile(stageFile).fileName;
      else failures.push({ fileName: describeChatUploadFile(stageFile).fileName, reason: "failed" });
    } catch {
      failures.push({ fileName: describeChatUploadFile(stageFile).fileName, reason: "failed" });
    }
    if (!presented && options.chatEnabled !== false) chatFiles.unshift(stageFile);
  }
  const limited = limitComposerFiles(chatFiles);
  return { presented, ...limited, chatOverflow: splitOverflow + limited.chatOverflow, failures };
}
