import { useEffect, useState, type RefObject } from "react";
import { CHALK_CHAT_ATTACHMENT_LIMITS, type ChatUploadFile } from "@q9labsai/chalk-client";
import type { prepareChatAttachmentBatch } from "./chat-upload-file";

/** Object URLs for the staged image files, revoked when the files change or the composer unmounts. */
export function useStagedFilePreviews(stagedFiles: readonly ChatUploadFile[]): ReadonlyMap<ChatUploadFile, string> {
  const [previews, setPreviews] = useState<ReadonlyMap<ChatUploadFile, string>>(new Map());
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Create object URLs for staged image files; revoke exactly those URLs when files change or the composer unmounts.
  useEffect(() => {
    const urls = new Map(stagedFiles.flatMap((file) => (file instanceof File && file.type.startsWith("image/") ? [[file, URL.createObjectURL(file)] as const] : [])));
    setPreviews(urls);
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [stagedFiles]);
  return previews;
}

/** Resizes the mounted textarea to its measured scrollHeight whenever the draft changes. */
export function useAutoGrowTextarea(textareaRef: RefObject<HTMLTextAreaElement | null>, draft: string): void {
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [dom] Resize the mounted textarea to its measured scrollHeight when the draft changes.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [draft]);
}

/** The composer notice for a selection batch: skipped empty files and the per-message cap. */
export function chatSelectionNotice(batch: ReturnType<typeof prepareChatAttachmentBatch>): string | null {
  const notices: string[] = [];
  if (batch.emptyCount) notices.push(batch.emptyCount === 1 ? "One empty file was skipped." : `${batch.emptyCount} empty files were skipped.`);
  if (batch.overflowCount) notices.push(`Only the first ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files can be attached to one message.`);
  return notices.length ? notices.join(" ") : null;
}

/** Stages a committed call drop once, then keeps the files still unsent with the parent until they are sent or removed. */
export function useChatDropRouting({
  droppedFiles,
  onDroppedFilesChange,
  stageFiles,
}: {
  readonly droppedFiles: { readonly key: number; readonly files: readonly ChatUploadFile[] } | undefined;
  readonly onDroppedFilesChange: ((key: number, files: readonly ChatUploadFile[]) => void) | undefined;
  readonly stageFiles: (files: readonly ChatUploadFile[]) => readonly ChatUploadFile[];
}): (files: readonly ChatUploadFile[]) => void {
  const retainDrop = (files: readonly ChatUploadFile[]) => {
    if (droppedFiles) onDroppedFilesChange?.(droppedFiles.key, files);
  };
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [transition] Route a committed window drop into the composer once; the key is the drop identity, so parent updates to its remaining files do not stage it again.
  useEffect(() => {
    if (droppedFiles) retainDrop(stageFiles(droppedFiles.files));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- [subscription] The composer only re-stages uploads when the staged-file identity list changes, not on every render.
  }, [droppedFiles?.key]);
  return retainDrop;
}
