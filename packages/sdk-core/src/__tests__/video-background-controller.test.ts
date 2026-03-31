import RealtimeKitVideoBackgroundTransformer from "@cloudflare/realtimekit-virtual-background";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConferenceSessionVideoBackgroundController, isConferenceSessionVideoBackgroundSupported } from "../conference-session/video-background-controller.ts";

describe("createConferenceSessionVideoBackgroundController", () => {
  const originalWindow = globalThis.window;
  const originalInit = RealtimeKitVideoBackgroundTransformer.init;
  const originalIsSupported = RealtimeKitVideoBackgroundTransformer.isSupported;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {} as Window & typeof globalThis,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    RealtimeKitVideoBackgroundTransformer.init = originalInit;
    RealtimeKitVideoBackgroundTransformer.isSupported = originalIsSupported;
  });

  it("reports background effects as unsupported while the temporary kill-switch is active", () => {
    RealtimeKitVideoBackgroundTransformer.isSupported = vi.fn(() => true) as typeof RealtimeKitVideoBackgroundTransformer.isSupported;

    const supported = isConferenceSessionVideoBackgroundSupported({
      self: {
        addVideoMiddleware: async () => {},
        removeAllVideoMiddlewares: async () => {},
      },
    } as any);

    expect(supported).toBe(false);
  });

  it("does not initialize RTK background middleware when asked to apply an effect", async () => {
    const addVideoMiddleware = vi.fn(async () => {});
    const removeAllVideoMiddlewares = vi.fn(async () => {});

    RealtimeKitVideoBackgroundTransformer.init = vi.fn(async () => ({
      createBackgroundBlurVideoMiddleware: vi.fn(async () => ({ id: "blur-middleware" })),
      createStaticBackgroundVideoMiddleware: vi.fn(async () => ({ id: "static-middleware" })),
      destruct: vi.fn(() => {}),
    })) as typeof RealtimeKitVideoBackgroundTransformer.init;
    RealtimeKitVideoBackgroundTransformer.isSupported = vi.fn(() => true) as typeof RealtimeKitVideoBackgroundTransformer.isSupported;

    const controller = createConferenceSessionVideoBackgroundController({
      getRtkClient: () =>
        ({
          self: {
            addVideoMiddleware,
            removeAllVideoMiddlewares,
            videoEnabled: true,
            videoTrack: {
              enabled: true,
              readyState: "live",
            } as MediaStreamTrack,
            rawVideoTrack: {
              enabled: true,
              readyState: "live",
            } as MediaStreamTrack,
          },
        }) as any,
    });

    const applied = await controller.applyBackgroundEffect({
      mode: "blur",
    });

    expect(applied).toBe(false);
    expect(addVideoMiddleware).not.toHaveBeenCalled();
    expect(removeAllVideoMiddlewares).not.toHaveBeenCalled();
    expect(RealtimeKitVideoBackgroundTransformer.init).not.toHaveBeenCalled();
    expect(controller.getSelectedBackgroundEffect()).toEqual({ mode: "none" });
  });
});
