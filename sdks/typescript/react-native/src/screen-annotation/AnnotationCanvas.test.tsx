import { Fragment, type ForwardedRef, type JSX } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { AnnotationCanvas } from "./AnnotationCanvas";

type CapturedWebViewProps = {
  readonly allowingReadAccessToURL?: string;
  readonly source?: { readonly uri?: string };
  readonly renderError?: (domain: string | undefined, code: number, description: string) => JSX.Element;
  readonly onError?: (event: { readonly nativeEvent: { readonly description: string } }) => void;
  readonly onMessage?: (event: { readonly nativeEvent: { readonly data: string } }) => void;
};

const webview = vi.hoisted(() => ({
  mounts: [] as string[],
  props: [] as CapturedWebViewProps[],
}));

vi.mock("react-native", () => ({
  StyleSheet: {
    absoluteFill: { position: "absolute" },
    create: <Styles,>(styles: Styles) => styles,
  },
  View: "View",
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly size = 0;
  },
}));

vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef(function MockWebView(props: CapturedWebViewProps, ref: ForwardedRef<unknown>) {
      webview.props.push(props);
      React.useImperativeHandle(ref, () => ({ injectJavaScript: () => undefined }));
      React.useEffect(() => {
        webview.mounts.push("mount");
        return () => {
          webview.mounts.push("unmount");
        };
      }, []);
      return null;
    }),
  };
});

const rendererUrl = "file:///Applications/Chalk.app/ChalkAnnotation.bundle/chalk-annotation/index.html";
const scene = {
  rect: { x: 0, y: 0, width: 320, height: 180 },
  clip: { x: 0, y: 0, width: 320, height: 180 },
  sharerId: "sharer",
  paused: false,
  marks: [],
  revision: 1,
};

function renderCanvas(ready: boolean[] = [], failures: string[] = []): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<AnnotationCanvas rendererUrl={rendererUrl} scene={scene} presence={[]} nowMs={0} onReady={(value) => ready.push(value)} onHit={() => undefined} onBakedInk={() => undefined} onFailure={(reason) => failures.push(reason)} />);
  });
  if (!renderer) throw new Error("The annotation canvas did not render");
  return renderer;
}

beforeEach(() => {
  webview.mounts.length = 0;
  webview.props.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it("grants the renderer directory and keeps WebView error chrome empty", () => {
  renderCanvas();

  const props = webview.props[0];
  expect(props?.source).toEqual({ uri: rendererUrl });
  expect(props?.allowingReadAccessToURL).toBe("file:///Applications/Chalk.app/ChalkAnnotation.bundle/chalk-annotation/");
  expect(props?.renderError?.(undefined, 0, "outside the sandbox").type).toBe(Fragment);
});

it("retries a failed renderer once, then removes the annotation overlay", () => {
  const ready: boolean[] = [];
  const failures: string[] = [];
  const renderer = renderCanvas(ready, failures);
  expect(webview.mounts).toEqual(["mount"]);

  act(() => webview.props.at(-1)?.onMessage?.({ nativeEvent: { data: "annotation-loaded" } }));
  expect(ready).toEqual([true]);

  act(() => webview.props.at(-1)?.onError?.({ nativeEvent: { description: "outside the sandbox" } }));
  expect(webview.mounts).toEqual(["mount", "unmount", "mount"]);
  expect(renderer.toJSON()).not.toBeNull();

  act(() => webview.props.at(-1)?.onError?.({ nativeEvent: { description: "outside the sandbox" } }));
  expect(webview.mounts).toEqual(["mount", "unmount", "mount", "unmount"]);
  expect(renderer.toJSON()).toBeNull();
  expect(ready).toEqual([true, false, false]);
  expect(failures).toEqual(["load"]);
});
