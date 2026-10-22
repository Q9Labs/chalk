import { expect, it, vi } from "vitest";
import { ownNativeBoardSession } from "./native-board-session";

it("subscribes when the call becomes live, survives reconnect, and releases exactly its own subscription", async () => {
  let status = "joining";
  let changed = () => {};
  const startSceneSubscription = vi.fn(async () => {});
  const stopSceneSubscription = vi.fn();
  const unsubscribe = vi.fn();
  const onError = vi.fn();
  const release = ownNativeBoardSession(
    {
      whiteboard: { transport: () => ({ startSceneSubscription, stopSceneSubscription }) },
      getSnapshot: () => ({ connection: { status } }),
      subscribe: (listener) => {
        changed = listener;
        return unsubscribe;
      },
    },
    onError,
  );
  expect(startSceneSubscription).not.toHaveBeenCalled();
  status = "live";
  changed();
  status = "reconnecting";
  changed();
  status = "live";
  changed();
  expect(startSceneSubscription).toHaveBeenCalledOnce();
  expect(stopSceneSubscription).not.toHaveBeenCalled();
  release();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(stopSceneSubscription).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it("does not announce a late startup failure after the call has closed", async () => {
  const onError = vi.fn();
  const release = ownNativeBoardSession(
    {
      whiteboard: {
        transport: () => ({
          startSceneSubscription: async () => {
            throw new Error("closed");
          },
          stopSceneSubscription: () => {},
        }),
      },
      getSnapshot: () => ({ connection: { status: "live" } }),
      subscribe: () => () => {},
    },
    onError,
  );
  release();
  await Promise.resolve();
  expect(onError).not.toHaveBeenCalled();
});
