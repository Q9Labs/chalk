import type { ChalkEmbeddedWhiteboardViewport } from "./protocol";
import { withLocalWhiteboardCamera, type WhiteboardViewportAppState } from "../collab/camera";

interface EmbeddedWhiteboardViewportApi {
  readonly getAppState: () => WhiteboardViewportAppState;
  readonly refresh: () => void;
  readonly updateScene: (scene: { readonly appState: WhiteboardViewportAppState }) => void;
}

export function applyEmbeddedWhiteboardViewport(api: EmbeddedWhiteboardViewportApi, container: HTMLElement, viewport: ChalkEmbeddedWhiteboardViewport): void {
  const localAppState = api.getAppState();
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  api.refresh();
  api.updateScene({ appState: withLocalWhiteboardCamera(undefined, localAppState) });
}
