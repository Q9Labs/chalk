import RealtimeKitVideoBackgroundTransformer from "@cloudflare/realtimekit-virtual-background";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { VideoBackgroundEffect } from "../types/entities/media.ts";

type VideoMiddlewareCapableSelf = {
  addVideoMiddleware?: (middleware: unknown) => Promise<unknown>;
  removeAllVideoMiddlewares?: () => Promise<unknown>;
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

export const isConferenceSessionVideoBackgroundSupported = (rtkClient?: RealtimeKitClient): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return RealtimeKitVideoBackgroundTransformer.isSupported() && hasMiddlewareApis(rtkClient);
};

export const createConferenceSessionVideoBackgroundController = (deps: { getRtkClient: () => RealtimeKitClient | undefined }) => {
  let transformer: RealtimeKitVideoBackgroundTransformer | null = null;
  let selectedEffect: VideoBackgroundEffect = { mode: "none" };

  const getTransformer = async (rtkClient: RealtimeKitClient) => {
    if (transformer) {
      return transformer;
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
      selectedEffect = { mode: "none" };
      return false;
    }

    await removeAllVideoMiddlewares(rtkClient);
    selectedEffect = { mode: "none" };
    return true;
  };

  const applyBackgroundEffect = async (effect: VideoBackgroundEffect): Promise<boolean> => {
    if (effect.mode === "none") {
      return clearBackgroundEffect();
    }

    const rtkClient = deps.getRtkClient();
    if (!isConferenceSessionVideoBackgroundSupported(rtkClient) || !hasMiddlewareApis(rtkClient)) {
      return false;
    }

    const resolvedTransformer = await getTransformer(rtkClient);
    await removeAllVideoMiddlewares(rtkClient);

    const middleware =
      effect.mode === "blur"
        ? await resolvedTransformer.createBackgroundBlurVideoMiddleware(effect.blurStrength ?? DEFAULT_BLUR_STRENGTH)
        : await resolvedTransformer.createStaticBackgroundVideoMiddleware(effect.imageUrl).catch((error: unknown) => {
            throw toBackgroundImageLoadError(effect.imageUrl, error);
          });

    await rtkClient.self.addVideoMiddleware?.(middleware);
    selectedEffect = effect;
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
  };
};
