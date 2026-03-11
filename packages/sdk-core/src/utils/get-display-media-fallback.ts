/**
 * Temporary getDisplayMedia patching to improve cross-browser screen sharing.
 *
 * Cloudflare RealtimeKit requests `getDisplayMedia({ audio: true, video: ... })`.
 * On iPadOS/Safari/WebKit, `{ audio: true }` (system audio) often fails even when
 * screen capture is supported. This helper retries with safer constraints.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const getErrorName = (err: unknown) => (isRecord(err) && typeof err.name === "string" ? err.name : undefined);
const isUserCancelledError = (name: string | undefined) => name === "AbortError" || name === "NotAllowedError";

const tryGetMediaDevices = () => {
  if (typeof navigator === "undefined") return undefined;
  const md = (navigator as any).mediaDevices as any;
  return md && typeof md.getDisplayMedia === "function" ? md : undefined;
};

const getNavigatorInfo = () => {
  if (typeof navigator === "undefined") {
    return {
      userAgent: "",
      platform: "",
      maxTouchPoints: 0,
    };
  }

  return {
    userAgent: navigator.userAgent ?? "",
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
};

const shouldDefaultScreenShareAudioOn = () => {
  const { userAgent, platform, maxTouchPoints } = getNavigatorInfo();
  const isIOS = /iPad|iPhone|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const isSafariFamily = /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS|OPR|Opera|SamsungBrowser/i.test(userAgent);

  return !(isIOS || isSafariFamily);
};

const supportsAntiMirrorHints = () => {
  const { userAgent } = getNavigatorInfo();

  return /Chrome|Chromium|Edg|OPR|Opera|SamsungBrowser/i.test(userAgent) && !/CriOS|EdgiOS/i.test(userAgent);
};

const buildConstraintsWithAudioPreference = (constraints: unknown, withAudio?: boolean) => {
  if (!isRecord(constraints)) {
    const next = {
      video: true,
      audio: withAudio ?? shouldDefaultScreenShareAudioOn(),
    };

    if (supportsAntiMirrorHints()) {
      (next as any).preferCurrentTab = false;
      (next as any).selfBrowserSurface = "exclude";
      (next as any).surfaceSwitching = "include";
    }

    return next;
  }

  const next = { ...constraints } as any;

  // Default behavior in Chalk: request screen-share audio on browsers that
  // commonly support it, but keep Safari/WebKit on the safer no-audio path
  // unless the caller explicitly opts in.
  next.audio = withAudio ?? shouldDefaultScreenShareAudioOn();

  // If video constraints are missing, ensure we at least request video.
  if (typeof next.video === "undefined") next.video = true;

  if (supportsAntiMirrorHints()) {
    next.preferCurrentTab = false;
    next.selfBrowserSurface = "exclude";
    next.surfaceSwitching ??= "include";
  }

  return next;
};

const stripToVideoOnly = (constraints: unknown) => {
  if (!isRecord(constraints)) return { video: true };
  const c = constraints as any;
  const video = typeof c.video === "object" && c.video !== null ? true : (c.video ?? true);
  return { video };
};

/**
 * Run a function with a temporary `navigator.mediaDevices.getDisplayMedia` wrapper.
 *
 * The wrapper:
 * - optionally forces `audio: false` (default)
 * - retries removing `audio` if the initial call fails
 * - retries stripping complex video constraints if needed
 */
export const withPatchedGetDisplayMedia = async (run: () => Promise<boolean>, opts?: { withAudio?: boolean }) => {
  const md = tryGetMediaDevices();
  if (!md) return run();

  const withAudio = opts?.withAudio;

  const originalFn = md.getDisplayMedia;
  const callOriginal = (constraints: unknown) => (originalFn as any).call(md, constraints);

  const wrapped = async (constraints: unknown) => {
    // 1) Prefer caller audio preference. Default keeps screen audio on where
    // it is commonly supported, while Safari/WebKit stays on the safer path.
    const preferred = buildConstraintsWithAudioPreference(constraints, withAudio);
    try {
      return await callOriginal(preferred);
    } catch (err1) {
      if (isUserCancelledError(getErrorName(err1))) {
        throw err1;
      }

      // 2) If audio might be the issue, retry without audio.
      const preferredAny = preferred as any;
      const audioWasRequested = preferredAny?.audio === true || (typeof preferredAny?.audio === "object" && preferredAny?.audio !== null);

      if (audioWasRequested) {
        try {
          return await callOriginal({ ...preferredAny, audio: false });
        } catch (err2) {
          if (isUserCancelledError(getErrorName(err2))) {
            throw err2;
          }
          err1 = err2;
        }
      }

      // 3) If complex constraints might be overconstraining, retry with video only.
      const name = getErrorName(err1);
      const shouldStripVideo = name === "OverconstrainedError" || name === "NotFoundError" || name === "TypeError" || (typeof preferredAny?.video === "object" && preferredAny?.video !== null);

      if (shouldStripVideo) {
        return callOriginal(stripToVideoOnly(preferredAny));
      }

      throw err1;
    }
  };

  // Some browsers expose getDisplayMedia as a non-writable property; fail open.
  let patched = false;
  try {
    md.getDisplayMedia = wrapped;
    patched = md.getDisplayMedia === wrapped;
  } catch {
    patched = false;
  }

  try {
    return await run();
  } finally {
    if (!patched) return;
    try {
      md.getDisplayMedia = originalFn;
    } catch {
      // ignore
    }
  }
};
