import { useCallback, useEffect, useRef, useState } from "react";
import { CHALK_CHAT_ATTACHMENT_LIMITS, presentingFormatsFor, type ChatUploadFile, type PresentingFormatId, type SpaceClient } from "@q9labsai/chalk-client";
import { presentFiles } from "../stage/presenting-files";

type Notify = (toast: { readonly type: "info" | "error"; readonly message: string; readonly duration?: number; readonly action?: { readonly label: string; readonly onClick: () => void } }) => void;

export interface FilePresentingOptions {
  readonly client: SpaceClient;
  readonly notify: Notify;
  readonly live: boolean;
  readonly chatOpen: boolean;
  readonly chatEnabled: boolean;
  readonly presentingAvailable: boolean;
  readonly formats: readonly PresentingFormatId[];
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly openChat: () => void;
}

/** Owns the Present popover's file flow: validation toasts, the first-file-to-stage split, and window drop routing. */
export function useFilePresenting({ client, notify, live, chatOpen, chatEnabled, presentingAvailable, formats, pickChatFiles, openChat }: FilePresentingOptions) {
  const presentAccept = presentingFormatsFor(formats)
    .flatMap((format) => [...format.mimeTypes, ...format.extensions.map((extension) => `.${extension}`)])
    .join(",");
  const [presentOpen, setPresentOpen] = useState(false);
  const [presentBusy, setPresentBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [chatDrop, setChatDrop] = useState<{ readonly key: number; readonly files: readonly ChatUploadFile[] }>();
  const presentInputRef = useRef<HTMLInputElement>(null);
  const dropDepth = useRef(0);
  const dropKey = useRef(0);

  const reportPresentingResult = useCallback(
    (result: Awaited<ReturnType<typeof presentFiles>>) => {
      if (result.presented) notify({ type: "info", message: `Showing ${result.presented} to everyone.` });
      for (const failure of result.failures) {
        const message =
          failure.reason === "too_big"
            ? `${failure.fileName} is over 25 MB.`
            : failure.reason === "empty"
              ? `${failure.fileName} is empty and was skipped.`
              : failure.reason === "unsupported"
                ? `${failure.fileName} can't be presented or sent in chat.`
                : chatEnabled
                  ? `${failure.fileName} could not be presented; it is waiting in chat.`
                  : `${failure.fileName} could not be presented.`;
        notify({ type: "error", duration: Infinity, message });
      }
      if (result.chatOverflow) {
        const noun = result.chatOverflow === 1 ? "file" : "files";
        notify({ type: "info", message: `Only the first ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files were staged; ${result.chatOverflow} ${noun} could not be added.` });
      }
    },
    [chatEnabled, notify],
  );

  const presentChosenFiles = useCallback(
    async (files: readonly ChatUploadFile[]) => {
      if (!files.length || presentBusy) return;
      setPresentBusy(true);
      setPresentOpen(false);
      try {
        const result = await presentFiles(files, client, { presentingAvailable, chatEnabled, formats });
        reportPresentingResult(result);
        if (result.chatFiles.length) {
          openChat();
          setChatDrop((current) => ({ key: ++dropKey.current, files: [...(current?.files ?? []), ...result.chatFiles] }));
        }
      } finally {
        setPresentBusy(false);
      }
    },
    [chatEnabled, client, formats, notify, openChat, presentBusy, presentingAvailable, reportPresentingResult],
  );

  const choosePresentFiles = useCallback(async () => {
    if (presentBusy) return;
    if (pickChatFiles) {
      try {
        await presentChosenFiles(await pickChatFiles());
      } catch {
        notify({ type: "error", duration: Infinity, message: "Could not read the selected file." });
      }
    } else {
      presentInputRef.current?.click();
    }
  }, [notify, pickChatFiles, presentBusy, presentChosenFiles]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Window file drops belong either to the open chat composer or directly to the Stage; remove the routing listeners with the call.
  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dropDepth.current += 1;
      setDropActive(true);
    };
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (dropDepth.current === 0) setDropActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dropDepth.current = 0;
      setDropActive(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length || !live) return;
      if (chatOpen && chatEnabled) setChatDrop((current) => ({ key: ++dropKey.current, files: [...(current?.files ?? []), ...files] }));
      else if (presentingAvailable || chatEnabled) void presentChosenFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [chatOpen, chatEnabled, live, notify, openChat, presentingAvailable, presentChosenFiles]);

  const dropTarget = chatOpen && chatEnabled ? "chat" : presentingAvailable ? "present" : chatEnabled ? "chat" : null;
  const updateChatDrop = useCallback((key: number, files: readonly ChatUploadFile[]) => {
    setChatDrop((current) => {
      if (current?.key !== key) return current;
      return files.length ? { ...current, files } : undefined;
    });
  }, []);

  return { presentOpen, setPresentOpen, presentBusy, dropActive, dropTarget, chatDrop, updateChatDrop, presentInputRef, presentAccept, choosePresentFiles, presentChosenFiles };
}
