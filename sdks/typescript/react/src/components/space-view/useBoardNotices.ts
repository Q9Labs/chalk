import { useCallback, useRef, useState } from "react";
import type { BoardToast } from "@q9labsai/chalk-whiteboard/react";
import type { Toast } from "../toast-stack/ToastStack";

export function useBoardNotices(boardOpen: boolean | undefined) {
  const [boardToasts, setBoardToasts] = useState<readonly Toast[]>([]);
  const boardToastCount = useRef(0);
  const [previousBoardOpen, setPreviousBoardOpen] = useState(boardOpen);
  if (previousBoardOpen !== boardOpen) {
    setPreviousBoardOpen(boardOpen);
    if (!boardOpen) setBoardToasts([]);
  }
  const showBoardToast = useCallback((toast: BoardToast | null) => {
    if (!toast) {
      setBoardToasts([]);
      return;
    }
    boardToastCount.current += 1;
    const id = `board-${boardToastCount.current}`;
    setBoardToasts((current) => [...current.slice(-2), { ...toast, id }]);
  }, []);
  const dismissBoardToast = (id: string) => setBoardToasts((current) => current.filter((toast) => toast.id !== id));
  return { boardToasts, showBoardToast, dismissBoardToast };
}
