import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

export type BoardToast = {
  readonly message: ReactNode;
  readonly icon?: ReactNode;
  readonly type?: "info" | "success" | "warning" | "error";
  readonly duration?: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
};

/** Null drops the board lifetime’s toasts, including their action callbacks.
 * Board events join the call's own toast stack, so they look, sit and time out like every other toast. */
export const BoardToastContext = createContext<(toast: BoardToast | null) => void>(() => undefined);

export function useBoardToast(lifetime: object | null): (toast: BoardToast) => void {
  const publish = useContext(BoardToastContext);
  const scope = useMemo(() => ({ active: true }), [lifetime]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      publish(null);
    };
  }, [publish, scope]);
  return useCallback(
    (toast: BoardToast) => {
      if (scope.active) publish(toast);
    },
    [publish, scope],
  );
}
