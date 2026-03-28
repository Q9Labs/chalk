import RealtimeKitVideoBackgroundTransformer from "@cloudflare/realtimekit-virtual-background";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { VideoBackgroundEffect } from "../types/entities/media.ts";
import { resolveBackgroundImageSource } from "./resolve-background-image-source.ts";

type VideoMiddlewareCapableSelf = {
  addVideoMiddleware?: (middleware: unknown) => Promise<unknown>;
  removeAllVideoMiddlewares?: () => Promise<unknown>;
  setVideoMiddlewareGlobalConfig?: (config: { disablePerFrameCanvasRendering?: boolean }) => Promise<unknown>;
  videoEnabled?: boolean;
  videoTrack?: MediaStreamTrack;
};

const DEFAULT_BLUR_STRENGTH = 50;

const toBackgroundImageLoadError = (imageUrl: string, error: unknown): Error & { code: string; cause?: unknown } => {
  if (error instanceof Error) {
    return Object.assign(error, {
      code: (error as Error & { code?: string }).code ?? "BACKGROUND_IMAGE_LOAD_FAILED",
    });
  }

  const eventType = error instanceof Event && error.type ? ` (${error.type})` : "";
  const wrapped = new Error(`Failed to load background image: ${imageUrl}${eventType}`) as Error & { code: string; cause?: unknown };
  wrapped.code = "BACKGROUND_IMAGE_LOAD_FAILED";
  wrapped.cause = error;
  return wrapped;
};

const hasMiddlewareApis = (rtkClient: RealtimeKitClient | undefined): rtkClient is RealtimeKitClient & { self: VideoMiddlewareCapableSelf } => {
  if (!rtkClient) {
    return false;
  }

  const self = rtkClient.self as unknown as VideoMiddlewareCapableSelf;
  return typeof self.addVideoMiddleware === "function" && typeof self.removeAllVideoMiddlewares === "function";
};

const hasLiveLocalVideoTrack = (rtkClient: RealtimeKitClient | undefined): rtkClient is RealtimeKitClient & { self: VideoMiddlewareCapableSelf } => {
  if (!rtkClient) {
    return false;
  }

  const self = rtkClient.self as unknown as VideoMiddlewareCapableSelf;
  const track = self.videoTrack;

  return self.videoEnabled === true && !!track && track.readyState === "live" && track.enabled;
};

export const isConferenceSessionVideoBackgroundSupported = (rtkClient?: RealtimeKitClient): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return RealtimeKitVideoBackgroundTransformer.isSupported() && hasMiddlewareApis(rtkClient);
};

export const createConferenceSessionVideoBackgroundController = (deps: { getRtkClient: () => RealtimeKitClient | undefined }) => {
  let transformer: RealtimeKitVideoBackgroundTransformer | null = null;
  let selectedEffect: VideoBackgroundEffect = { mode: "none" };
  let revokeResolvedBackgroundImage: (() => void) | undefined;

  const resetResolvedBackgroundImage = () => {
    revokeResolvedBackgroundImage?.();
    revokeResolvedBackgroundImage = undefined;
  };

  const destroyTransformer = () => {
    try {
      transformer?.destruct?.();
    } catch {
      // best effort cleanup
    }
    transformer = null;
  };

  const getTransformer = async (rtkClient: RealtimeKitClient) => {
    if (transformer) {
      return transformer;
    }

    try {
      await (rtkClient.self as unknown as VideoMiddlewareCapableSelf).setVideoMiddlewareGlobalConfig?.({
        disablePerFrameCanvasRendering: true,
      });
    } catch {
      // best effort for RTK runtimes that do not expose this API
    }

    transformer = await RealtimeKitVideoBackgroundTransformer.init({
      meeting: rtkClient,
    });
    return transformer;
  };

  const removeAllVideoMiddlewares = async (rtkClient: RealtimeKitClient & { self: VideoMiddlewareCapableSelf }) => {
    await rtkClient.self.removeAllVideoMiddlewares?.();
  };

  const clearBackgroundEffect = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    if (!hasMiddlewareApis(rtkClient)) {
      resetResolvedBackgroundImage();
      destroyTransformer();
      selectedEffect = { mode: "none" };
      return false;
    }

    await removeAllVideoMiddlewares(rtkClient);
    resetResolvedBackgroundImage();
    destroyTransformer();
    selectedEffect = { mode: "none" };
    return true;
  };

  const suspendBackgroundEffect = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const hadSelectedEffect = selectedEffect.mode !== "none";

    if (hasMiddlewareApis(rtkClient)) {
      await rtkClient.self.removeAllVideoMiddlewares?.().catch?.(() => {
        // best effort during transport loss
      });
    }

    resetResolvedBackgroundImage();
    destroyTransformer();
    return hadSelectedEffect;
  };

  const applyBackgroundEffect = async (effect: VideoBackgroundEffect): Promise<boolean> => {
    if (effect.mode === "none") {
      return clearBackgroundEffect();
    }

    const rtkClient = deps.getRtkClient();
    if (!isConferenceSessionVideoBackgroundSupported(rtkClient) || !hasMiddlewareApis(rtkClient)) {
      return false;
    }

    selectedEffect = effect;

    if (!hasLiveLocalVideoTrack(rtkClient)) {
      return true;
    }

    const resolvedTransformer = await getTransformer(rtkClient);
    await removeAllVideoMiddlewares(rtkClient);

    const middleware = effect.mode === "blur"
      ? await resolvedTransformer.createBackgroundBlurVideoMiddleware(effect.blurStrength ?? DEFAULT_BLUR_STRENGTH)
      : await (async () => {
          const resolvedImage = await resolveBackgroundImageSource(effect.imageUrl).catch((error: unknown) => {
            throw toBackgroundImageLoadError(effect.imageUrl, error);
          });

          try {
            const staticMiddleware = await resolvedTransformer.createStaticBackgroundVideoMiddleware(resolvedImage.imageUrl).catch((error: unknown) => {
              throw toBackgroundImageLoadError(effect.imageUrl, error);
            });

            resetResolvedBackgroundImage();
            revokeResolvedBackgroundImage = resolvedImage.revoke;
            return staticMiddleware;
          } catch (error) {
            resolvedImage.revoke?.();
            throw error;
          }
        })();

    await rtkClient.self.addVideoMiddleware?.(middleware);
    return true;
  };

  const reapplySelectedBackgroundEffect = async (): Promise<boolean> => {
    if (selectedEffect.mode === "none") {
      return true;
    }

    return applyBackgroundEffect(selectedEffect);
  };

  const getSelectedBackgroundEffect = (): VideoBackgroundEffect => selectedEffect;

  return {
    applyBackgroundEffect,
    clearBackgroundEffect,
    getSelectedBackgroundEffect,
    reapplySelectedBackgroundEffect,
    suspendBackgroundEffect,
  };
};
