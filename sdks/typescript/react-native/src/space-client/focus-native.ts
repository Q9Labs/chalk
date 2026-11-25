import { AppState, Dimensions, type AppStateStatus } from "react-native";

type FocusState = "active" | "inactive" | "background";
type Report = { readonly state: FocusState; readonly windowed: boolean };
const GRACE_MS = 2000;

function currentReport(): Report {
  const window = Dimensions.get("window");
  const screen = Dimensions.get("screen");
  const windowed = window.width < screen.width || window.height < screen.height;
  const state: FocusState = AppState.currentState === "active" ? "active" : AppState.currentState === "inactive" ? "inactive" : "background";
  return { state, windowed };
}

function same(left: Report, right: Report): boolean {
  return left.state === right.state && left.windowed === right.windowed;
}

/**
 * React Native Focus detection. AppState covers background and iOS inactive; a window smaller
 * than the screen covers iPad Split View/Slide Over and Android multi-window on the React Native surface.
 */
export function observeNativeFocus(input: {
  readonly report: (state: FocusState, windowed: boolean) => void;
  readonly isScreenSharing: () => boolean;
}): () => void {
  let current = observable(input);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    const next = observable(input);
    if (same(next, current)) {
      clear();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const settled = observable(input);
      if (same(settled, current)) return;
      current = settled;
      input.report(current.state, current.windowed);
    }, GRACE_MS);
  };
  input.report(current.state, current.windowed);
  const appState = AppState.addEventListener("change", schedule as (state: AppStateStatus) => void);
  const dimensions = Dimensions.addEventListener("change", schedule);
  return () => {
    clear();
    appState.remove();
    dimensions.remove();
  };
}

function observable(input: { readonly isScreenSharing: () => boolean }): Report {
  const report = currentReport();
  return input.isScreenSharing() ? { state: "active", windowed: report.windowed } : report;
}
