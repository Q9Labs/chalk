import { useEffect, useRef } from "react";

interface UseRealtimeKitPreloadParams {
  roomId: string;
  session: unknown;
  pushIncidentBreadcrumb: (category: string, message: string, data?: Record<string, unknown>) => void;
}

export function useRealtimeKitPreload({ roomId, session, pushIncidentBreadcrumb }: UseRealtimeKitPreloadParams) {
  const preloadStartedRef = useRef(false);

  useEffect(() => {
    if (preloadStartedRef.current) {
      return;
    }
    preloadStartedRef.current = true;

    const chalkClient = (
      session as {
        chalkClient?: {
          preloadRealtimeKit?: () => Promise<boolean>;
        };
      }
    ).chalkClient;
    const preloadRealtimeKit = chalkClient?.preloadRealtimeKit;
    if (typeof preloadRealtimeKit !== "function") {
      return;
    }

    void preloadRealtimeKit.call(chalkClient).then((succeeded: boolean) => {
      if (!succeeded) {
        pushIncidentBreadcrumb("join", "RealtimeKit preload failed (will retry on join)", { roomId });
      }
    });
  }, [pushIncidentBreadcrumb, roomId, session]);
}
