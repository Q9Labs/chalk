import type { AppState } from "./types";

export type SharedWhiteboardAppState = { readonly viewBackgroundColor?: string };
export type WhiteboardViewportAppState = Pick<AppState, "scrollX" | "scrollY" | "zoom" | "viewBackgroundColor">;

export function withLocalWhiteboardCamera(sharedAppState: SharedWhiteboardAppState | undefined, localAppState: WhiteboardViewportAppState): WhiteboardViewportAppState {
  return {
    viewBackgroundColor: sharedAppState?.viewBackgroundColor ?? localAppState.viewBackgroundColor,
    scrollX: localAppState.scrollX,
    scrollY: localAppState.scrollY,
    zoom: localAppState.zoom,
  };
}
