import type { ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationPresence } from "@q9labsai/chalk-client";
import { projectAnnotationMark, type AnnotationTextMeasure } from "@q9labsai/chalk-screen-annotation";
import { File } from "expo-file-system";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import type { PresentedAnnotationFrame } from "../components/rtc-video-view-availability";
import type { Frame } from "../motion/MovingFrame";
import type { ScreenAnnotationFrame } from "./model";

export type AnnotationScene = {
  readonly rect: Frame;
  readonly clip: Frame;
  readonly sharerId: string;
  readonly paused: boolean;
  readonly burnedIn?: true;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly revision: number;
};
export type AnnotationCanvasHandle = {
  readonly presented: (frame: PresentedAnnotationFrame) => void;
  readonly sampled: (png: string) => void;
  readonly holdInk: (sample: ScreenAnnotationPresence) => void;
  readonly watchInk: (sample: ScreenAnnotationPresence, revision: number) => void;
  readonly settleInk: (id: string, revision: number | null) => void;
  readonly hit: (request: number, point: ScreenAnnotationPoint, actor: string | null) => void;
  readonly measure: (frame: ScreenAnnotationFrame) => Promise<AnnotationTextMeasure>;
  readonly png: (frame: ScreenAnnotationFrame<string>) => Promise<string>;
};
export type AnnotationCanvasProps = {
  readonly rendererUrl: string;
  readonly scene: AnnotationScene;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly nowMs: number;
  readonly localTouch?: { readonly point: ScreenAnnotationPoint; readonly untilMs: number };
  readonly onReady: (ready: boolean) => void;
  readonly onHit: (request: number, markId: string | null) => void;
  readonly onBakedInk: (id: string, handedOff: boolean) => void;
};

type ExportJob = {
  readonly id: number;
  readonly parts: string[];
  readonly resolve: (bytes: string) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  length: number;
};
type TextSample = readonly [text: string, size: number];
type MeasureJob = {
  readonly id: number;
  readonly samples: readonly TextSample[];
  readonly resolve: (measure: AnnotationTextMeasure) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};
const maxBase64Length = 16 * 1024 * 1024;
const chunkSize = 32768;

function annotationHit(result: object): result is { hit: number; markId: string | null } {
  return "hit" in result && "markId" in result && typeof result.hit === "number" && (result.markId === null || (typeof result.markId === "string" && result.markId.length <= 36));
}

function annotationPngPart(result: object, currentLength: number): result is { part: string; final: boolean } {
  return !("failed" in result) && "part" in result && "final" in result && typeof result.part === "string" && typeof result.final === "boolean" && result.part.length <= chunkSize && /^[\w+/=]+$/.test(result.part) && currentLength + result.part.length <= maxBase64Length;
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(function AnnotationCanvas({ rendererUrl, scene, presence, nowMs, localTouch, onReady, onHit, onBakedInk }, ref) {
  const view = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const job = useRef<ExportJob | null>(null);
  const nextId = useRef(0);
  const measures = useRef<MeasureJob | null>(null);

  function failMeasure(): void {
    const current = measures.current;
    if (!current) return;
    measures.current = null;
    clearTimeout(current.timer);
    current.reject(new Error("Unable to measure annotation text"));
  }

  function failExport(): void {
    const current = job.current;
    if (!current) return;
    job.current = null;
    clearTimeout(current.timer);
    current.reject(new Error("Unable to encode the marked frame"));
  }

  useImperativeHandle(ref, () => ({
    presented: (frame) => view.current?.injectJavaScript(`window.chalkAnnotationPresented?.(${JSON.stringify(frame)});true;`),
    sampled: (png) => view.current?.injectJavaScript(`window.chalkAnnotationDecodedSample?.(${JSON.stringify(png)});true;`),
    holdInk: (sample) => view.current?.injectJavaScript(`window.chalkAnnotationHoldInk?.(${JSON.stringify(sample)});true;`),
    watchInk: (sample, revision) => view.current?.injectJavaScript(`window.chalkAnnotationWatchInk?.(${JSON.stringify(sample)},${revision});true;`),
    settleInk: (id, revision) => view.current?.injectJavaScript(`window.chalkAnnotationSettleInk?.(${JSON.stringify(id)},${JSON.stringify(revision)});true;`),
    hit: (request, point, actor) => view.current?.injectJavaScript(`window.chalkAnnotationHit?.(${request},${JSON.stringify(point)},${JSON.stringify(actor)});true;`),
    async measure({ size, marks }) {
      const rect = { x: 0, y: 0, ...size };
      const samples = new Map<string, TextSample>();
      for (const { draft } of marks) {
        const projected = projectAnnotationMark(rect, draft);
        if (projected.kind !== "text") continue;
        for (const line of projected.text.split(/\r\n?|\n/)) {
          const sample = [line, projected.fontSize] as const;
          samples.set(JSON.stringify(sample), sample);
        }
      }
      if (!samples.size) return () => 0;
      const web = view.current;
      if (!ready || !web || measures.current) throw new Error("The annotation renderer is busy");
      const id = ++nextId.current;
      const entries = [...samples.values()];
      return new Promise((resolve, reject) => {
        measures.current = { id, samples: entries, resolve, reject, timer: setTimeout(failMeasure, 5_000) };
        web.injectJavaScript(`window.chalkAnnotationMeasure?.(${id},${JSON.stringify(entries)});true;`);
      });
    },
    async png({ image, ...frame }) {
      if (!ready || !view.current || job.current) throw new Error("Another frame export is in progress");
      const { current: web } = view;
      const file = new File(image);
      if (file.size > (maxBase64Length * 3) / 4) throw new Error("Frame is too large to export");
      const base64 = await file.base64();
      if (base64.length > maxBase64Length || web !== view.current || job.current) throw new Error("Frame is no longer available");
      const id = ++nextId.current;
      return new Promise((resolve, reject) => {
        job.current = { id, parts: [], resolve, reject, timer: setTimeout(failExport, 15_000), length: 0 };
        web.injectJavaScript(`window.chalkAnnotationExport?.(${id},${JSON.stringify(frame)});true;`);
        for (let at = 0; at < base64.length; at += chunkSize) {
          const part = base64.slice(at, at + chunkSize);
          web.injectJavaScript(`window.chalkAnnotationExportPart?.(${id},${JSON.stringify(part)},${at + chunkSize >= base64.length});true;`);
        }
      });
    },
  }));

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Replace the committed layer only when it or the video rect changes.
  useEffect(() => {
    if (ready) view.current?.injectJavaScript(`window.chalkAnnotationScene?.(${JSON.stringify(scene)});true;`);
  }, [ready, scene]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Transient samples don't resend the committed scene.
  useEffect(() => {
    if (ready) view.current?.injectJavaScript(`window.chalkAnnotationPresence?.(${JSON.stringify(presence)},${nowMs},${JSON.stringify(localTouch ?? null)});true;`);
  }, [ready, presence, nowMs, localTouch]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Fail the pending export if the sandbox goes away before returning PNG data.
  useEffect(
    () => () => {
      failExport();
      failMeasure();
    },
    [],
  );

  const onMessage = ({ nativeEvent: { data } }: WebViewMessageEvent) => {
    if (data === "annotation-loaded") {
      setReady(true);
      onReady(true);
      return;
    }
    if (data.length > chunkSize + 128) return;
    try {
      const result: unknown = JSON.parse(data);
      if (typeof result !== "object" || result === null) return;
      if ("bakedInk" in result && typeof result.bakedInk === "string" && result.bakedInk.length <= 36) {
        onBakedInk(result.bakedInk, "handoff" in result && result.handoff === true);
        return;
      }
      if (annotationHit(result)) {
        onHit(result.hit, result.markId);
        return;
      }
      const measurement = measures.current;
      if (measurement && "measure" in result && result.measure === measurement.id) {
        const widths: unknown = "widths" in result ? result.widths : null;
        if (!Array.isArray(widths) || widths.length !== measurement.samples.length || !widths.every((width): width is number => typeof width === "number" && Number.isFinite(width) && width >= 0)) {
          failMeasure();
          return;
        }
        clearTimeout(measurement.timer);
        measures.current = null;
        const lookup = new Map(measurement.samples.map((sample, index) => [JSON.stringify(sample), widths[index]]));
        measurement.resolve((text, size) => lookup.get(JSON.stringify([text, size])) ?? 0);
        return;
      }
      const current = job.current;
      if (!current || !("png" in result) || result.png !== current.id) return;
      if (!annotationPngPart(result, current.length)) {
        failExport();
        return;
      }
      current.parts.push(result.part);
      current.length += result.part.length;
      if (result.final) {
        job.current = null;
        clearTimeout(current.timer);
        current.resolve(current.parts.join(""));
      }
    } catch {
      // A malformed response cannot issue a command.
    }
  };
  function reset() {
    failExport();
    failMeasure();
    setReady(false);
    onReady(false);
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={view}
        source={{ uri: rendererUrl }}
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(event) => event.url === rendererUrl}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        mixedContentMode="never"
        cacheEnabled={false}
        domStorageEnabled={false}
        scrollEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        onMessage={onMessage}
        onLoadStart={reset}
        onLoad={(event) => {
          if (event.nativeEvent.url !== rendererUrl) return;
          // Android can drop bridge messages sent by the page while loading.
          view.current?.injectJavaScript(`if (typeof window.chalkAnnotationScene === "function") window.ReactNativeWebView?.postMessage("annotation-loaded");true;`);
        }}
        onError={reset}
        onContentProcessDidTerminate={reset}
        onRenderProcessGone={reset}
        style={styles.clear}
        containerStyle={styles.clear}
      />
    </View>
  );
});

const styles = StyleSheet.create({ clear: { backgroundColor: "transparent" } });
