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

  const createLiveVideoTrack = () =>
    ({
      enabled: true,
      readyState: "live",
    }) as MediaStreamTrack;

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
            videoEnabled: true,
            videoTrack: createLiveVideoTrack(),
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
            videoEnabled: true,
            videoTrack: createLiveVideoTrack(),
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

  it("defers middleware attachment until the local video track is live", async () => {
    const createStaticBackgroundVideoMiddleware = mock(async () => ({ id: "static-middleware" }));
    const addVideoMiddleware = mock(async () => {});
    const removeAllVideoMiddlewares = mock(async () => {});
    const setVideoMiddlewareGlobalConfig = mock(async () => {});

    RealtimeKitVideoBackgroundTransformer.init = mock(async () => ({
      createBackgroundBlurVideoMiddleware: mock(async () => ({ id: "blur-middleware" })),
      createStaticBackgroundVideoMiddleware,
      destruct: mock(() => {}),
    })) as typeof RealtimeKitVideoBackgroundTransformer.init;
    RealtimeKitVideoBackgroundTransformer.isSupported = mock(() => true) as typeof RealtimeKitVideoBackgroundTransformer.isSupported;

    const imageBlob = new Blob(["image"], { type: "image/png" });
    globalThis.fetch = mock(async () => new Response(imageBlob, { status: 200 })) as typeof fetch;

    let videoEnabled = false;
    let videoTrack: MediaStreamTrack | undefined;

    const controller = createConferenceSessionVideoBackgroundController({
      getRtkClient: () =>
        ({
          self: {
            addVideoMiddleware,
            removeAllVideoMiddlewares,
            setVideoMiddlewareGlobalConfig,
            videoEnabled,
            videoTrack,
          },
        }) as any,
    });

    const selectedWhileVideoOff = await controller.applyBackgroundEffect({
      mode: "image",
      imageUrl: "https://cdn.example.com/background.png",
    });

    expect(selectedWhileVideoOff).toBe(true);
    expect(addVideoMiddleware).not.toHaveBeenCalled();
    expect(RealtimeKitVideoBackgroundTransformer.init).not.toHaveBeenCalled();

    videoEnabled = true;
    videoTrack = {
      enabled: true,
      readyState: "live",
    } as MediaStreamTrack;

    await controller.reapplySelectedBackgroundEffect();

    expect(RealtimeKitVideoBackgroundTransformer.init).toHaveBeenCalledTimes(1);
    expect(createStaticBackgroundVideoMiddleware).toHaveBeenCalledWith("blob:resolved-background");
    expect(addVideoMiddleware).toHaveBeenCalledTimes(1);
  });
});
