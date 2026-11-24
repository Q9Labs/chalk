type CaptureSurface = "browser" | "window" | "monitor" | null;

export function isHelperBrowser(userAgent: string): boolean {
  return /(?:Chrome|Chromium)\//.test(userAgent);
}

export function chromiumWindowId(label: string): string | undefined {
  // A fourth ":s" field labels an opaque OS picker session, not a window.
  return /^window:([1-9][0-9]{0,18}):-?[0-9]+$/.exec(label)?.[1];
}

export function classifyHelperCapture(surface: CaptureSurface, track: MediaStreamTrack | undefined, userAgent: string) {
  const settings = track?.getSettings();
  const chromium = isHelperBrowser(userAgent);
  const monitor = chromium && surface === "monitor" && settings?.displaySurface === "monitor" && Boolean(settings.width && settings.height);
  const windowId = chromium && surface === "window" && settings?.displaySurface === "window" && track ? chromiumWindowId(track.label) : undefined;
  return { chromium, settings, monitor, windowId };
}
