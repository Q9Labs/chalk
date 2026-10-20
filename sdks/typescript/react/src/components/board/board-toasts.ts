import { createContext, useContext } from "react";
import type { Toast } from "../toast-stack/ToastStack";

export type BoardToast = Omit<Toast, "id">;

/** Board events join the call's own toast stack, so they look, sit and time out like every other toast. */
export const BoardToastContext = createContext<(toast: BoardToast) => void>(() => undefined);

export function useBoardToast(): (toast: BoardToast) => void {
  return useContext(BoardToastContext);
}
