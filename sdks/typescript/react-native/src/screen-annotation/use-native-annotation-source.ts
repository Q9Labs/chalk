import type { ScreenAnnotationFrameSize } from "@q9labsai/chalk-client";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { useEffect, useState } from "react";
import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { ScreenAnnotationSource } from "./model";
import { annotationRendererUrl } from "./renderer-url";

const frameEvent = "chalkAnnotationFrameSize";
type AnnotationFrames = {
  readonly observe: (key: string, streamUrl: string) => void;
  readonly stop: (key: string) => void;
  readonly capture: (key: string, width: number, height: number) => Promise<string | null>;
  readonly sample?: (key: string, width: number, height: number) => Promise<string | null>;
  readonly addListener: (event: string) => void;
  readonly removeListeners: (count: number) => void;
};

export function useNativeAnnotationSource(streamUrl: string | null): ScreenAnnotationSource | null {
  const [bound, setBound] = useState<{ readonly streamUrl: string; readonly source: ScreenAnnotationSource } | null>(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Tie the native decoded-frame sink to this stream and remove it before attaching the next one.
  useEffect(() => {
    const frames = NativeModules.ChalkAnnotationFrames as AnnotationFrames | undefined;
    if (!frames || !streamUrl) return;
    const key = randomUUID();
    let size: ScreenAnnotationFrameSize | null = null;
    let rendererUrl: string | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const stream = streamUrl;
    const sink = frames;

    function attach(attempt: number) {
      if (stopped || size) return;
      sink.observe(key, stream);
      if (attempt < 5) retry = setTimeout(() => attach(attempt + 1), 350 * attempt);
    }

    function publish() {
      if (!size || !rendererUrl || stopped) return;
      const expected = size;
      setBound({
        streamUrl: stream,
        source: {
          rendererUrl,
          size: expected,
          sampleFrame: sink.sample ? () => sink.sample?.(key, expected.width, expected.height) ?? Promise.resolve(null) : undefined,
          captureFrame: async () => {
            const image = await sink.capture(key, expected.width, expected.height);
            if (!image?.startsWith("file://")) return null;
            const release = () => {
              const file = new File(image);
              if (file.exists) file.delete();
            };
            if (stopped) {
              release();
              return null;
            }
            return { image, release };
          },
        },
      });
    }

    const events = Platform.OS === "ios" ? new NativeEventEmitter(frames) : DeviceEventEmitter;
    const listener = events.addListener(frameEvent, (event: { readonly key: string; readonly width: number; readonly height: number }) => {
      if (event.key !== key || stopped || !validSize(event)) return;
      size = { width: event.width, height: event.height };
      publish();
    });
    void annotationRendererUrl()
      .then((url) => {
        rendererUrl = url;
        publish();
      })
      .catch(() => undefined);
    attach(1);

    return () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      listener.remove();
      sink.stop(key);
      setBound((current) => (current?.streamUrl === stream ? null : current));
    };
  }, [streamUrl]);

  return bound?.streamUrl === streamUrl ? bound.source : null;
}

function validSize(size: ScreenAnnotationFrameSize): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0;
}
