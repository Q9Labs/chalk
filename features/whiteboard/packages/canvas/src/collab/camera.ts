import type { AppState } from "./types";

export type WhiteboardCamera = Pick<AppState, "scrollX" | "scrollY" | "zoom">;
export type SharedWhiteboardAppState = { readonly viewBackgroundColor?: string };
export type WhiteboardViewportAppState = Pick<AppState, "scrollX" | "scrollY" | "zoom" | "viewBackgroundColor">;

export function getWhiteboardCamera(appState: WhiteboardCamera): WhiteboardCamera {
  return {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom,
  };
}

export function withLocalWhiteboardCamera(sharedAppState: SharedWhiteboardAppState | undefined, localAppState: WhiteboardViewportAppState): WhiteboardViewportAppState {
  return {
    viewBackgroundColor: sharedAppState?.viewBackgroundColor ?? localAppState.viewBackgroundColor,
    ...getWhiteboardCamera(localAppState),
  };
}
