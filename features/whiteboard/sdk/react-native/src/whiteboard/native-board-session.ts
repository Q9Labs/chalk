import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";

type SessionClient = {
  readonly whiteboard: { readonly transport: () => Pick<ChalkWhiteboardV1Transport, "startSceneSubscription" | "stopSceneSubscription"> | null };
  readonly getSnapshot: () => { readonly connection: { readonly status: string } };
  readonly subscribe: (listener: () => void) => () => void;
};

/** Subscribe before the tile exists, so a web presentation can open the native board. */
export function ownNativeBoardSession(client: SessionClient, onError: () => void): () => void {
  const transport = client.whiteboard.transport();
  if (!transport) return () => {};
  let started = false;
  let active = true;
  const observe = () => {
    if (started || client.getSnapshot().connection.status !== "live") return;
    started = true;
    void transport.startSceneSubscription().catch(() => {
      if (active) onError();
    });
  };
  const unsubscribe = client.subscribe(observe);
  observe();
  return () => {
    active = false;
    unsubscribe();
    if (started) void transport.stopSceneSubscription();
  };
}
