import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { Toast } from "../toast-stack/ToastStack";

export type BoardToast = Omit<Toast, "id">;

/** Null drops the board lifetime’s toasts, including their action callbacks.
 * Board events join the call's own toast stack, so they look, sit and time out like every other toast. */
export const BoardToastContext = createContext<(toast: BoardToast | null) => void>(() => undefined);

export function useBoardToast(lifetime: object | null, visible: boolean): (toast: BoardToast) => void {
  const publish = useContext(BoardToastContext);
  const scope = useMemo(() => ({ active: visible }), [lifetime, visible]);
  useEffect(() => {
    scope.active = visible;
    return () => {
      scope.active = false;
      publish(null);
    };
  }, [publish, scope, visible]);
  return useCallback(
    (toast: BoardToast) => {
      if (scope.active) publish(toast);
    },
    [publish, scope],
  );
}
