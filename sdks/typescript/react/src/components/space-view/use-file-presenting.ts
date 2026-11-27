import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHALK_CHAT_ATTACHMENT_LIMITS, type ChatUploadFile, type SpaceClient } from "@q9labsai/chalk-client";
import { describeChatUploadFile } from "../composite/chat-upload-file";
import { chatAcceptsFile, presentFiles, splitPresentingFiles, type PresentingFileFailure } from "../stage/presenting-files";

type Notify = (toast: { readonly type: "info" | "error"; readonly message: string; readonly duration?: number; readonly action?: { readonly label: string; readonly onClick: () => void } }) => void;

export type DropZone = "present" | "chat";

/**
 * The presenter's own view of a file on its way to the Stage, before Sync has a Document for it.
 * It appears the moment a file is chosen or dropped, so the Stage never goes quiet while bytes upload.
 */
export type StageUpload = { readonly kind: "uploading"; readonly fileName: string; readonly progress: number | null } | { readonly kind: "failed"; readonly fileName: string; readonly reason: PresentingFileFailure["reason"]; readonly file?: ChatUploadFile };

export interface FilePresentingOptions {
  readonly client: SpaceClient;
  readonly notify: Notify;
  readonly live: boolean;
  readonly chatOpen: boolean;
  readonly chatEnabled: boolean;
  readonly presentingAvailable: boolean;
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly openChat: () => void;
}

/** Where a dropped file can go: only the composer while chat is open, otherwise the Stage and chat side by side. */
export function dropZonesFor(chatOpen: boolean, chatEnabled: boolean, presentingAvailable: boolean): readonly DropZone[] {
  if (chatOpen && chatEnabled) return ["chat"];
  return [...(presentingAvailable ? (["present"] as const) : []), ...(chatEnabled ? (["chat"] as const) : [])];
}

function dropZoneAt(event: DragEvent): DropZone | null {
  const zone = typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-zone]") : null;
  const value = zone?.dataset.dropZone;
  return value === "present" || value === "chat" ? value : null;
}

/** Owns the Present file flow: the picker, window drop routing, the Stage upload placeholder and its failure card. */
export function useFilePresenting({ client, notify, live, chatOpen, chatEnabled, presentingAvailable, pickChatFiles, openChat }: FilePresentingOptions) {
  const [stageUpload, setStageUpload] = useState<StageUpload | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [chatDrop, setChatDrop] = useState<{ readonly key: number; readonly files: readonly ChatUploadFile[] }>();
  const presentInputRef = useRef<HTMLInputElement>(null);
  const dropDepth = useRef(0);
  const dropKey = useRef(0);
  const presentBusy = stageUpload?.kind === "uploading";

  const stageInChat = useCallback(
    (files: readonly ChatUploadFile[]) => {
      openChat();
      setChatDrop((current) => ({ key: ++dropKey.current, files: [...(current?.files ?? []), ...files] }));
    },
    [openChat],
  );

  const reportOtherFailures = useCallback(
    (failures: readonly PresentingFileFailure[], chatOverflow: number) => {
      for (const failure of failures) {
        const message = failure.reason === "too_big" ? `${failure.fileName} is over 25 MB.` : failure.reason === "empty" ? `${failure.fileName} is empty and was skipped.` : `${failure.fileName} can't be presented or sent in chat.`;
        notify({ type: "error", duration: Infinity, message });
      }
      if (chatOverflow) {
        const noun = chatOverflow === 1 ? "file" : "files";
        notify({ type: "info", message: `Only the first ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files were staged; ${chatOverflow} ${noun} could not be added.` });
      }
    },
    [notify],
  );

  const presentChosenFiles = useCallback(
    async (files: readonly ChatUploadFile[], zone: DropZone = "present") => {
      if (!files.length || presentBusy) return;
      const stageAvailable = presentingAvailable && zone === "present";
      const split = splitPresentingFiles(files, { presentingAvailable: stageAvailable, chatEnabled });
      // Nothing here can go on the Stage: the first file's problem is the presenter's answer, shown where they looked.
      if (stageAvailable && !split.stageFile && split.failures[0] && !split.chatFiles.length) {
        const [first, ...rest] = split.failures;
        const file = files.find((candidate) => describeChatUploadFile(candidate).fileName === first.fileName);
        setStageUpload({ kind: "failed", fileName: first.fileName, reason: first.reason, ...(file && chatEnabled && chatAcceptsFile(file) ? { file } : {}) });
        reportOtherFailures(rest, split.chatOverflow);
        return;
      }
      const result = await presentFiles(files, client, {
        presentingAvailable: stageAvailable,
        chatEnabled,
        onStageFile: (fileName) => setStageUpload({ kind: "uploading", fileName, progress: null }),
        onProgress: (progress) => setStageUpload((current) => (current?.kind === "uploading" ? { ...current, progress } : current)),
      });
      setStageUpload(result.stageFailure ? { kind: "failed", fileName: result.stageFailure.failure.fileName, reason: "failed", file: result.stageFailure.file } : null);
      reportOtherFailures(result.failures, result.chatOverflow);
      if (result.chatFiles.length) stageInChat(result.chatFiles);
    },
    [chatEnabled, client, presentBusy, presentingAvailable, reportOtherFailures, stageInChat],
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

  const dismissStageUpload = useCallback(() => setStageUpload((current) => (current?.kind === "failed" ? null : current)), []);

  const retryStageUpload = useCallback(() => {
    if (stageUpload?.kind !== "failed") return;
    if (stageUpload.reason === "failed" && stageUpload.file) void presentChosenFiles([stageUpload.file]);
    else {
      setStageUpload(null);
      void choosePresentFiles();
    }
  }, [choosePresentFiles, presentChosenFiles, stageUpload]);

  const sendStageUploadToChat = useCallback(() => {
    if (stageUpload?.kind !== "failed" || !stageUpload.file) return;
    setStageUpload(null);
    stageInChat([stageUpload.file]);
  }, [stageInChat, stageUpload]);

  const dropZones = dropZonesFor(chatOpen, chatEnabled, presentingAvailable);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Window file drops belong either to the open chat composer or to the zone under the pointer; remove the routing listeners with the call.
  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dropDepth.current += 1;
      setDropActive(true);
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDropZone(dropZoneAt(event));
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
      setDropZone(null);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length || !live) return;
      const zones = dropZonesFor(chatOpen, chatEnabled, presentingAvailable);
      const zone = zones.length > 1 ? (dropZoneAt(event) ?? zones[0]) : zones[0];
      if (zone === "chat" && chatOpen) stageInChat(files);
      else if (zone) void presentChosenFiles(files, zone);
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
  }, [chatEnabled, chatOpen, live, presentChosenFiles, presentingAvailable, stageInChat]);

  const updateChatDrop = useCallback((key: number, files: readonly ChatUploadFile[]) => {
    setChatDrop((current) => {
      if (current?.key !== key) return current;
      return files.length ? { ...current, files } : undefined;
    });
  }, []);

  const documentActions = useMemo(() => ({ presentAnother: presentingAvailable ? () => void choosePresentFiles() : undefined }), [choosePresentFiles, presentingAvailable]);

  return { documentActions, presentBusy, stageUpload, dismissStageUpload, retryStageUpload, sendStageUploadToChat, dropActive, dropZones, dropZone, chatDrop, updateChatDrop, presentInputRef, choosePresentFiles, presentChosenFiles };
}
