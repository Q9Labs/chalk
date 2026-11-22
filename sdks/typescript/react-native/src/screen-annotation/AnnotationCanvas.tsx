import type { ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationPresence } from "@q9labsai/chalk-client";
import { File } from "expo-file-system";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import type { Frame } from "../motion/MovingFrame";
import type { ScreenAnnotationFrame } from "./model";

export type AnnotationScene = {
  readonly rect: Frame;
  readonly clip: Frame;
  readonly sharerId: string;
  readonly paused: boolean;
  readonly marks: readonly ScreenAnnotationMark[];
};
export type AnnotationCanvasHandle = {
  readonly hit: (request: number, point: ScreenAnnotationPoint, actor: string | null) => void;
  readonly png: (frame: ScreenAnnotationFrame<string>) => Promise<string>;
};
export type AnnotationCanvasProps = {
  readonly rendererUrl: string;
  readonly scene: AnnotationScene;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly nowMs: number;
  readonly onReady: (ready: boolean) => void;
  readonly onHit: (request: number, markId: string | null) => void;
};

type ExportJob = {
  readonly id: number;
  readonly parts: string[];
  readonly resolve: (bytes: string) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  length: number;
};
const maxBase64Length = 16 * 1024 * 1024;
const chunkSize = 32768;

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(function AnnotationCanvas({ rendererUrl, scene, presence, nowMs, onReady, onHit }, ref) {
  const view = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const job = useRef<ExportJob | null>(null);
  const nextId = useRef(0);

  function failExport(): void {
    const current = job.current;
    if (!current) return;
    job.current = null;
    clearTimeout(current.timer);
    current.reject(new Error("Unable to encode the marked frame"));
  }

  useImperativeHandle(ref, () => ({
    hit: (request, point, actor) => view.current?.injectJavaScript(`window.chalkAnnotationHit?.(${request},${JSON.stringify(point)},${JSON.stringify(actor)});true;`),
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
    if (ready) view.current?.injectJavaScript(`window.chalkAnnotationPresence?.(${JSON.stringify(presence)},${nowMs});true;`);
  }, [ready, presence, nowMs]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Fail the pending export if the sandbox goes away before returning PNG data.
  useEffect(() => failExport, []);

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
      if ("hit" in result && "markId" in result && typeof result.hit === "number" && (result.markId === null || (typeof result.markId === "string" && result.markId.length <= 36))) {
        onHit(result.hit, result.markId);
        return;
      }
      const current = job.current;
      if (!current || !("png" in result) || result.png !== current.id) return;
      if ("failed" in result || !("part" in result) || !("final" in result) || typeof result.part !== "string" || typeof result.final !== "boolean" || result.part.length > chunkSize || !/^[\w+/=]+$/.test(result.part) || current.length + result.part.length > maxBase64Length) {
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
