export type FocusAppState = "active" | "inactive" | "background";
export type FocusReport = { readonly state: FocusAppState; readonly windowed: boolean };
export type WebFocusEnvironment = {
  readonly document: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener" | "pictureInPictureElement">;
  readonly window: Pick<Window, "innerWidth" | "innerHeight" | "addEventListener" | "removeEventListener"> & { readonly screen: Pick<Screen, "width" | "height"> };
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly isScreenSharing?: () => boolean;
  readonly isTransientPickerOpen?: () => boolean;
};
const GRACE_MS = 2000;
/** Reports the observable browser window state. A change is held for two seconds so quick switches never flicker. */
export function observeWebFocus(environment: WebFocusEnvironment, report: (report: FocusReport) => void): () => void {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let current = observable(environment);
  const clear = () => {
    if (timer !== null) environment.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    const next = observable(environment);
    if (same(next, current)) {
      clear();
      return;
    }
    if (timer !== null) return;
    timer = environment.setTimeout(() => {
      timer = null;
      const settled = observable(environment);
      if (same(settled, current)) return;
      current = settled;
      report(current);
    }, GRACE_MS);
  };
  const changed = () => schedule();
  report(current);
  environment.document.addEventListener("visibilitychange", changed);
  environment.window.addEventListener("blur", changed);
  environment.window.addEventListener("focus", changed);
  return () => {
    clear();
    environment.document.removeEventListener("visibilitychange", changed);
    environment.window.removeEventListener("blur", changed);
    environment.window.removeEventListener("focus", changed);
  };
}
function observable(environment: WebFocusEnvironment): FocusReport {
  const windowed = environment.window.innerWidth < environment.window.screen.width || environment.window.innerHeight < environment.window.screen.height;
  if (suppressed(environment)) return { state: "active", windowed };
  if (environment.document.visibilityState === "hidden") return { state: "background", windowed };
  return { state: environment.document.hasFocus() ? "active" : "inactive", windowed };
}
function suppressed(environment: WebFocusEnvironment): boolean {
  return Boolean(environment.isScreenSharing?.() || environment.isTransientPickerOpen?.() || environment.document.pictureInPictureElement);
}
function same(left: FocusReport, right: FocusReport): boolean {
  return left.state === right.state && left.windowed === right.windowed;
}
