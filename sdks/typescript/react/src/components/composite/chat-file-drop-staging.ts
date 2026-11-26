import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { useEffect, useRef, type ClipboardEvent } from "react";
import type { ChatPanelFileDrop } from "./chat-types";

type StageFiles = (files: FileList | readonly ChatUploadFile[] | null) => void;

/** Stages each file drop the call surface commits, once per drop object. */
export function useStagedChatFileDrop({ fileDrop, onFileDropStaged, stageFiles }: { readonly fileDrop?: ChatPanelFileDrop; readonly onFileDropStaged?: (drop: ChatPanelFileDrop) => void; readonly stageFiles: StageFiles }) {
  const stageRef = useRef(stageFiles);
  const handledRef = useRef<ChatPanelFileDrop | null>(null);
  stageRef.current = stageFiles;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [transition] Stage a file drop committed by the call surface once for each drop object.
  useEffect(() => {
    if (!fileDrop || handledRef.current === fileDrop) return;
    handledRef.current = fileDrop;
    stageRef.current(fileDrop.files);
    onFileDropStaged?.(fileDrop);
  }, [fileDrop, onFileDropStaged]);
}

/** Stages files pasted into the composer; plain text paste is left to the browser. */
export function stagePastedFiles(event: ClipboardEvent<HTMLTextAreaElement>, canUpload: boolean, stageFiles: StageFiles) {
  if (!canUpload || event.clipboardData.files.length === 0) return;
  event.preventDefault();
  stageFiles(event.clipboardData.files);
}
