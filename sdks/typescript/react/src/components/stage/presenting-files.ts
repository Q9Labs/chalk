import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatUploadFile, type SpaceClient } from "@q9labsai/chalk-client";
import { describeChatUploadFile } from "../composite/chat-upload-file";

export const PRESENTABLE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PresentingFileFailure = { readonly fileName: string; readonly reason: "unsupported" | "too_big" | "failed" };
export type PresentingFileResult = {
  readonly presented?: string;
  readonly chatted: number;
  readonly failures: readonly PresentingFileFailure[];
};

export function presentingFileProblem(file: ChatUploadFile): "unsupported" | "too_big" | null {
  const description = describeChatUploadFile(file);
  if (description.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "too_big";
  return PRESENTABLE_MIME_TYPES.has(description.mimeType) ? null : "unsupported";
}

/** Uploads the first presentable file to the renderer and puts it on the Stage when Presenting is available; other sendable files go to chat. */
export async function presentFiles(files: readonly ChatUploadFile[], client: SpaceClient, options: { readonly presentingAvailable?: boolean; readonly chatEnabled?: boolean } = {}): Promise<PresentingFileResult> {
  const presentingAvailable = options.presentingAvailable !== false;
  const chatEnabled = options.chatEnabled !== false;
  const failures: PresentingFileFailure[] = [];
  const chatFiles: ChatUploadFile[] = [];
  let stageFile: ChatUploadFile | undefined;
  for (const file of files) {
    const description = describeChatUploadFile(file);
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
  }
  let chatted = 0;
  const attachments = [];
  for (const file of chatFiles) {
    try {
      attachments.push(await client.chat.files.upload(file));
      chatted += 1;
    } catch {
      failures.push({ fileName: describeChatUploadFile(file).fileName, reason: "failed" });
    }
  }
  if (attachments.length) {
    try {
      await client.chat.send({ text: "", attachments });
    } catch {
      for (const file of chatFiles) failures.push({ fileName: describeChatUploadFile(file).fileName, reason: "failed" });
      chatted = 0;
    }
  }
  return { presented, chatted, failures };
}
