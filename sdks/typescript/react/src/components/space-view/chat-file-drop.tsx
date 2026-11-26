import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type DragEventHandler } from "react";
import { ChatFileDropOverlay } from "../composite/ChatFileDropOverlay";
import type { ChatPanelFileDrop } from "../composite/chat-types";

export type ChatFileDropRoute = "chat" | "stage" | "unavailable";

const closedChatFileDropRoute: ChatFileDropRoute = "chat";

export function routeChatFileDrop({ chatOpen, chatAvailable }: { readonly chatOpen: boolean; readonly chatAvailable: boolean }): ChatFileDropRoute {
  if (!chatAvailable) return "unavailable";
  if (chatOpen) return "chat";
  return closedChatFileDropRoute;
}

export function dragHasFiles(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function whiteboardImageDrop(event: ReactDragEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".chalk-board")) return false;
  return Array.from(event.dataTransfer.files).some((file) => file.type.startsWith("image/"));
}

export function useChatFileDrop({ route, onChatFiles }: { readonly route: ChatFileDropRoute; readonly onChatFiles: (files: readonly ChatUploadFile[]) => void }) {
  const depth = useRef(0);
  const [active, setActive] = useState(false);
  const clear = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Clear file-drag chrome on Escape or window focus loss; remove the listeners on cleanup.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", clear);
    };
  }, [clear]);

  const onDragEnterCapture: DragEventHandler<HTMLElement> = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth.current += 1;
    setActive(true);
  };
  const onDragOverCapture: DragEventHandler<HTMLElement> = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = route === "unavailable" ? "none" : "copy";
    setActive(true);
  };
  const onDragLeaveCapture: DragEventHandler<HTMLElement> = (event) => {
    if (!dragHasFiles(event.dataTransfer) && depth.current === 0) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setActive(false);
  };
  const onDropCapture: DragEventHandler<HTMLElement> = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    clear();
  };
  const onDrop: DragEventHandler<HTMLElement> = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (route !== "chat" || whiteboardImageDrop(event)) return;
    onChatFiles(Array.from(event.dataTransfer.files));
  };

  return {
    active,
    handlers: {
      onDragEnterCapture,
      onDragOverCapture,
      onDragLeaveCapture,
      onDropCapture,
      onDrop,
    },
  };
}

/** The file-drop state a call surface needs: the drop target, the chrome while a file is dragged over the chat, and the staged drop. */
export function useChatFileDropFlow({ chatOpen, chatAvailable, onOpenChat }: { readonly chatOpen: boolean; readonly chatAvailable: boolean; readonly onOpenChat: () => void }) {
  const [fileDrop, setFileDrop] = useState<ChatPanelFileDrop | null>(null);
  const route = routeChatFileDrop({ chatOpen, chatAvailable });
  const target = useChatFileDrop({
    route,
    onChatFiles: (files) => {
      onOpenChat();
      setFileDrop({ files });
    },
  });
  const showing = target.active && route === "chat" && chatOpen;
  return {
    handlers: target.handlers,
    overlay: showing ? <ChatFileDropOverlay /> : undefined,
    dimmer: showing ? <div className="call-file-drop-dimmer" data-part="chat-file-drop-dimmer" /> : null,
    panelProps: {
      fileDrop: fileDrop ?? undefined,
      onFileDropStaged: (drop: ChatPanelFileDrop) => setFileDrop((current) => (current === drop ? null : current)),
    },
  };
}
