import type { createReactNativeSyncLifecycle, ReactNativeAppState, SpaceSnapshot } from "@q9labsai/chalk-client";

type CallState = {
  getSnapshot(): {
    connection: Pick<SpaceSnapshot["connection"], "status">;
    media: { screenShare: Pick<SpaceSnapshot["media"]["screenShare"], "state"> };
  };
  subscribe(listener: () => void): () => void;
};

export function createAndroidCallSyncLifecycle(appState: ReactNativeAppState, getClient: () => CallState): ReturnType<typeof createReactNativeSyncLifecycle> {
  return {
    subscribe(listener) {
      const client = getClient();
      let deviceState = appState.currentState;
      let lastEvent: "active" | "inactive" | undefined;
      const update = () => {
        const { connection, media } = client.getSnapshot();
        // The projection chooser backgrounds Chalk before the capture promise
        // resolves. Losing Sync then cancels the pending screen publication.
        const inCall = connection.status === "live" || connection.status === "reconnecting";
        const sharing = media.screenShare.state === "requesting" || media.screenShare.state === "enabled";
        const event = deviceState === "active" || (inCall && sharing) ? "active" : "inactive";
        if (lastEvent === event) return;
        lastEvent = event;
        listener(event);
      };
      const deviceSubscription = appState.addEventListener("change", (state) => {
        if (state === "inactive") return;
        deviceState = state;
        update();
      });
      const unsubscribe = client.subscribe(update);
      update();
      return () => {
        if (typeof deviceSubscription === "function") deviceSubscription();
        else deviceSubscription.remove();
        unsubscribe();
      };
    },
  };
}
