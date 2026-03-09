/**
 * useNotifications - Notifications from UIManager
 */

import type { Notification, NotificationSeverity, UIState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseNotificationsReturn {
  /** Active notifications */
  notifications: readonly Notification[];
  /** Add a notification */
  notify: (message: string, severity?: NotificationSeverity, autoDismiss?: boolean) => string;
  /** Dismiss a notification */
  dismiss: (id: string) => void;
  /** Clear all notifications */
  clear: () => void;
}

/**
 * Hook for notifications
 *
 * @example
 * ```tsx
 * function NotificationStack() {
 *   const { notifications, dismiss } = useNotifications();
 *
 *   return (
 *     <div className="notification-stack">
 *       {notifications.map(notif => (
 *         <div key={notif.id} className={`notification ${notif.severity}`}>
 *           {notif.message}
 *           <button onClick={() => dismiss(notif.id)}>x</button>
 *         </div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useNotifications(): UseNotificationsReturn {
  const session = useSession();
  const { ui } = session;

  const [state, setState] = useState<UIState>(() => ui.getState());

  useEffect(() => {
    return ui.subscribe(setState);
  }, [ui]);

  const notify = useCallback((message: string, severity: NotificationSeverity = "info", autoDismiss = true): string => ui.notify(message, severity, autoDismiss), [ui]);

  const dismiss = useCallback((id: string): void => ui.dismissNotification(id), [ui]);

  const clear = useCallback((): void => ui.clearNotifications(), [ui]);

  return useMemo(
    (): UseNotificationsReturn => ({
      notifications: state.notifications,
      notify,
      dismiss,
      clear,
    }),
    [state.notifications, notify, dismiss, clear],
  );
}
