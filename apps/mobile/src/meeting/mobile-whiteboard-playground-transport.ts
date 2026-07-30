import type { ChalkEmbeddedWhiteboardProps } from "@q9labsai/chalk-react-native";

type PlaygroundTransport = ChalkEmbeddedWhiteboardProps["transport"];
type PlaygroundEvent = Parameters<Parameters<PlaygroundTransport["subscribe"]>[0]>[0];
type PlaygroundElement = Parameters<PlaygroundTransport["submitUpdate"]>[0]["elements"][number];

export function createMobileWhiteboardPlaygroundTransport(): PlaygroundTransport {
  const listeners = new Set<(event: PlaygroundEvent) => void>();
  let elements: readonly PlaygroundElement[] = [];
  let revision = 0;
  let sceneEpoch = 0;
  let sceneId = playgroundSceneId(sceneEpoch);
  let started = false;

  const nextRevision = (): string => String(++revision);
  const emit = (event: PlaygroundEvent): void => {
    if (!started) return;
    listeners.forEach((listener) => listener(event));
  };
  const snapshot = (): void => {
    emit({
      type: "snapshot",
      sceneId,
      revision: String(revision),
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
    });
  };
  const commit = () => ({
    operationId: `local-operation-${sceneEpoch}-${revision}`,
    sceneId,
    revision: String(revision),
  });

  return {
    async startSceneSubscription() {
      started = true;
      snapshot();
    },
    stopSceneSubscription() {
      started = false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submitUpdate(input) {
      const byId = new Map(elements.map((element) => [element.id, element]));
      input.elements.forEach((element) => byId.set(element.id, element));
      elements = [...byId.values()];
      const next = nextRevision();
      emit({ type: "update", sceneId, revision: next, elements: input.elements });
      return commit();
    },
    sendCursor() {},
    async requestSnapshot() {
      snapshot();
    },
    async clear() {
      elements = [];
      sceneEpoch += 1;
      sceneId = playgroundSceneId(sceneEpoch);
      revision = 1;
      snapshot();
      return commit();
    },
    files: {
      async initiateUpload() {
        throw new Error("Files are unavailable in the local-only whiteboard playground.");
      },
      async finalizeUpload() {
        throw new Error("Files are unavailable in the local-only whiteboard playground.");
      },
      async getDownloadUrl() {
        throw new Error("Files are unavailable in the local-only whiteboard playground.");
      },
    },
  };
}

function playgroundSceneId(epoch: number): string {
  return `local-renderer-playground-${epoch}`;
}
