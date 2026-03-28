import RealtimeKitVideoBackgroundTransformer from "@cloudflare/realtimekit-virtual-background";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { createConferenceSessionVideoBackgroundController } from "../conference-session/video-background-controller.ts";

describe("createConferenceSessionVideoBackgroundController", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  const originalInit = RealtimeKitVideoBackgroundTransformer.init;
  const originalIsSupported = RealtimeKitVideoBackgroundTransformer.isSupported;
  const createObjectUrl = mock(() => "blob:resolved-background");
  const revokeObjectUrl = mock(() => {});

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {} as Window & typeof globalThis,
    });

    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: {
        ...URL,
        createObjectURL: createObjectUrl,
        revokeObjectURL: revokeObjectUrl,
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: originalUrl,
    });

    RealtimeKitVideoBackgroundTransformer.init = originalInit;
    RealtimeKitVideoBackgroundTransformer.isSupported = originalIsSupported;
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

  it("resolves image backgrounds to local object URLs before creating middleware", async () => {
    const createStaticBackgroundVideoMiddleware = mock(async () => ({ id: "static-middleware" }));
    const addVideoMiddleware = mock(async () => {});
    const removeAllVideoMiddlewares = mock(async () => {});
    const destruct = mock(() => {});

    RealtimeKitVideoBackgroundTransformer.init = mock(async () => ({
      createBackgroundBlurVideoMiddleware: mock(async () => ({ id: "blur-middleware" })),
      createStaticBackgroundVideoMiddleware,
      destruct,
    })) as typeof RealtimeKitVideoBackgroundTransformer.init;
    RealtimeKitVideoBackgroundTransformer.isSupported = mock(() => true) as typeof RealtimeKitVideoBackgroundTransformer.isSupported;

    const imageBlob = new Blob(["image"], { type: "image/png" });
    globalThis.fetch = mock(async () => new Response(imageBlob, { status: 200 })) as typeof fetch;

    const controller = createConferenceSessionVideoBackgroundController({
      getRtkClient: () =>
        ({
          self: {
            addVideoMiddleware,
            removeAllVideoMiddlewares,
          },
        }) as any,
    });

    const applied = await controller.applyBackgroundEffect({
      mode: "image",
      imageUrl: "https://cdn.example.com/background.png",
    });

    expect(applied).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://cdn.example.com/background.png");
    expect(createStaticBackgroundVideoMiddleware).toHaveBeenCalledWith("blob:resolved-background");
    expect(addVideoMiddleware).toHaveBeenCalledWith({ id: "static-middleware" });

    await controller.clearBackgroundEffect();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:resolved-background");
    expect(destruct).toHaveBeenCalledTimes(1);
  });

  it("suspends and reapplies the selected background effect across reconnects", async () => {
    const createStaticBackgroundVideoMiddleware = mock(async () => ({ id: `static-${createStaticBackgroundVideoMiddleware.mock.calls.length + 1}` }));
    const addVideoMiddleware = mock(async () => {});
    const removeAllVideoMiddlewares = mock(async () => {});
    const setVideoMiddlewareGlobalConfig = mock(async () => {});
    const destruct = mock(() => {});

    RealtimeKitVideoBackgroundTransformer.init = mock(async () => ({
      createBackgroundBlurVideoMiddleware: mock(async () => ({ id: "blur-middleware" })),
      createStaticBackgroundVideoMiddleware,
      destruct,
    })) as typeof RealtimeKitVideoBackgroundTransformer.init;
    RealtimeKitVideoBackgroundTransformer.isSupported = mock(() => true) as typeof RealtimeKitVideoBackgroundTransformer.isSupported;

    const imageBlob = new Blob(["image"], { type: "image/png" });
    globalThis.fetch = mock(async () => new Response(imageBlob, { status: 200 })) as typeof fetch;

    const controller = createConferenceSessionVideoBackgroundController({
      getRtkClient: () =>
        ({
          self: {
            addVideoMiddleware,
            removeAllVideoMiddlewares,
            setVideoMiddlewareGlobalConfig,
          },
        }) as any,
    });

    await controller.applyBackgroundEffect({
      mode: "image",
      imageUrl: "https://cdn.example.com/background.png",
    });
    await controller.suspendBackgroundEffect();
    await controller.reapplySelectedBackgroundEffect();

    expect(removeAllVideoMiddlewares).toHaveBeenCalledTimes(3);
    expect(addVideoMiddleware).toHaveBeenCalledTimes(2);
    expect(setVideoMiddlewareGlobalConfig).toHaveBeenCalledTimes(2);
    expect(RealtimeKitVideoBackgroundTransformer.init).toHaveBeenCalledTimes(2);
    expect(destruct).toHaveBeenCalledTimes(1);
  });
});
