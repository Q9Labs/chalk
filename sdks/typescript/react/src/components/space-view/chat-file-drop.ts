import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type DragEventHandler } from "react";

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

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Clear file-drag chrome on Escape or window focus loss; remove the listeners on cleanup.
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
