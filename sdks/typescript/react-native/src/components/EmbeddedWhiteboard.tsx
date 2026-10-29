import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardTransport, type ChalkEmbeddedBoardContext, type ChalkEmbeddedWhiteboardViewport } from "@q9labsai/chalk-whiteboard/embedded";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { exportBoardImage } from "../whiteboard/export-board-image";
import { useToasts } from "../primitives/toast/ToastStack";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import { isEmbeddedWhiteboardNavigationAllowed, rendererURLWithContext, resolveEmbeddedWhiteboardRendererURL } from "../whiteboard/embedded-whiteboard-assets";
import { createEmbeddedWhiteboardViewport } from "../whiteboard/embedded-whiteboard-viewport";

export interface EmbeddedWhiteboardProps {
  readonly board: ChalkEmbeddedBoardContext;
  readonly onFollow?: (participantId: string | null) => void;
  readonly onCloseBoard?: () => void;
  readonly transport: ChalkEmbeddedWhiteboardTransport;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly theme?: "light" | "dark";
  readonly localParticipantColor?: string;
  readonly rendererURL?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> }) => void;
  readonly onError?: (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => void;
  readonly onUserExport?: (value: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string; readonly action?: "download" | "copy" }) => void | Promise<void>;
}

export const embeddedWhiteboardWebViewSecurityPolicy = Object.freeze({
  allowFileAccess: true,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  cacheEnabled: false,
  domStorageEnabled: true,
  javaScriptCanOpenWindowsAutomatically: false,
  javaScriptEnabled: true,
  mixedContentMode: "never" as const,
  setSupportMultipleWindows: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
});

export function EmbeddedWhiteboard({
  board,
  onFollow,
  onCloseBoard,
  transport,
  journeyId,
  traceparent,
  tracestate,
  canDraw,
  canClear,
  theme: themeOverride,
  localParticipantColor,
  rendererURL: rendererURLOverride,
  style,
  testID,
  onMetric,
  onError,
  onUserExport,
}: EmbeddedWhiteboardProps): React.JSX.Element {
  const toasts = useToasts();
  const noticesRef = useRef(new Map<string, number>());
  const clearNotices = useCallback(() => {
    noticesRef.current.forEach((id) => toasts.dismiss(id));
    noticesRef.current.clear();
  }, [toasts]);
  const theme = themeOverride ?? "light";
  const webViewRef = useRef<WebView>(null);
  const controllerRef = useRef<ChalkWhiteboardController | null>(null);
  const listenersRef = useRef(new Set<(message: string) => void>());
  const boardRef = useRef(board);
  boardRef.current = board;
  const onFollowRef = useRef(onFollow);
  onFollowRef.current = onFollow;
  const onCloseBoardRef = useRef(onCloseBoard);
  onCloseBoardRef.current = onCloseBoard;
  const onMetricRef = useRef(onMetric);
  const onErrorRef = useRef(onError);
  const onUserExportRef = useRef(onUserExport);
  const [rendererURL, setRendererURL] = useState<string | null>(null);
  const [rendererGeneration, setRendererGeneration] = useState(createRendererGeneration);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compatibilityNotice, setCompatibilityNotice] = useState<string | null>(null);
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { scale } = useWindowDimensions();
  const viewport = useMemo<ChalkEmbeddedWhiteboardViewport | null>(() => createEmbeddedWhiteboardViewport(layout.width, layout.height, scale), [layout.height, layout.width, scale]);
  const latestViewportRef = useRef(viewport);
  latestViewportRef.current = viewport;
  onMetricRef.current = onMetric;
  onErrorRef.current = onError;
  onUserExportRef.current = onUserExport;

  const rendererPort = useMemo(
    () => ({
      postMessage: (message: string) => webViewRef.current?.postMessage(message),
      subscribe: (listener: (message: string) => void) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
    }),
    [],
  );
  const handleControllerError = useCallback((error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => onErrorRef.current?.(error), []);
  const handleControllerMetric = useCallback((metric: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> }) => onMetricRef.current?.(metric), []);
  const handleControllerUserExport = useCallback(async (value: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string; readonly action?: "download" | "copy" }) => {
    if (onUserExportRef.current) {
      await onUserExportRef.current(value);
      return;
    }
    await exportBoardImage(value);
  }, []);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing embedded native board lifecycle and cleanup.
  useEffect(() => {
    let active = true;
    setLoadError(null);
    void resolveEmbeddedWhiteboardRendererURL(rendererURLOverride)
      .then((url) => {
        if (active) setRendererURL(url);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : "Chalk whiteboard assets are unavailable";
        setLoadError(message);
        onError?.({ code: "renderer_asset_unavailable", message, recoverable: false });
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, onError, rendererURLOverride]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing embedded native board lifecycle and cleanup.
  useEffect(() => {
    setCompatibilityNotice(null);
    const controller = new ChalkWhiteboardController({
      renderer: rendererPort,
      transport,
      journeyId,
      ...(traceparent ? { traceparent } : {}),
      ...(tracestate ? { tracestate } : {}),
      board: boardRef.current,
      manageSceneSubscription: false,
      onNotice: (notice) => {
        if (!notice) {
          clearNotices();
          return;
        }
        const toastId = toasts.show({
          kind: notice.kind,
          message: notice.message,
          dismissible: notice.kind === "error",
          ...(notice.actionLabel
            ? {
                actions: [
                  {
                    label: notice.actionLabel,
                    onPress: () => {
                      controller.performNoticeAction(notice.id);
                      const id = noticesRef.current.get(notice.id);
                      if (id !== undefined) toasts.dismiss(id);
                    },
                  },
                ],
              }
            : {}),
        });
        noticesRef.current.set(notice.id, toastId);
        if (noticesRef.current.size > 8) {
          const oldest = noticesRef.current.entries().next().value;
          if (oldest) {
            toasts.dismiss(oldest[1]);
            noticesRef.current.delete(oldest[0]);
          }
        }
      },
      onFollow: (id) => onFollowRef.current?.(id),
      onCloseBoard: () => onCloseBoardRef.current?.(),
      canDraw,
      canClear,
      theme,
      ...(localParticipantColor ? { localParticipantColor } : {}),
      onMetric: handleControllerMetric,
      onError: handleControllerError,
      onCompatibilityChange: (state) => setCompatibilityNotice(state.message),
      onUserExport: handleControllerUserExport,
    });
    controller.start();
    if (latestViewportRef.current) controller.setViewport(latestViewportRef.current);
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.stop();
      clearNotices();
    };
  }, [clearNotices, toasts, handleControllerError, handleControllerMetric, handleControllerUserExport, journeyId, localParticipantColor, rendererPort, theme, traceparent, tracestate, transport]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing embedded native board lifecycle and cleanup.
  useEffect(() => {
    controllerRef.current?.setBoard(board);
  }, [board]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing embedded native board lifecycle and cleanup.
  useEffect(() => {
    controllerRef.current?.setCapabilities({ canDraw, canClear });
  }, [canClear, canDraw]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing embedded native board lifecycle and cleanup.
  useEffect(() => {
    if (viewport) controllerRef.current?.setViewport(viewport);
  }, [viewport]);
  const handleLayout = useCallback((event: LayoutChangeEvent): void => {
    const next = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    setLayout((current) => (current.width === next.width && current.height === next.height ? current : next));
  }, []);

  const sourceURL = rendererURL ? rendererURLWithContext(rendererURL, { journeyId, rendererGeneration }) : null;
  const handleMessage = (event: WebViewMessageEvent): void => {
    const message = event.nativeEvent.data;
    listenersRef.current.forEach((listener) => listener(message));
  };
  const allowNavigation = (request: WebViewNavigation): boolean => Boolean(rendererURL && isEmbeddedWhiteboardNavigationAllowed(request.url, rendererURL));
  const reloadRenderer = (): void => {
    clearNotices();
    controllerRef.current?.rendererReloaded();
    setRendererGeneration(createRendererGeneration());
  };
  const retryRenderer = (): void => {
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
    reloadRenderer();
  };
  const handleRendererTermination = (): void => {
    handleControllerMetric({ name: "whiteboard.renderer.termination", value: 1 });
    handleControllerError({
      code: "renderer_terminated",
      message: "The whiteboard renderer stopped and is recovering.",
      recoverable: true,
    });
    reloadRenderer();
  };

  if (loadError) {
    return (
      <View style={[{ flex: 1 }, style]} testID={testID}>
        <Text>Whiteboard unavailable</Text>
        <Text>{loadError}</Text>
        <Pressable accessibilityRole="button" onPress={retryRenderer}>
          <Text>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!sourceURL || !rendererURL) {
    return (
      <View style={[{ flex: 1 }, style]} testID={testID}>
        <ActivityIndicator />
        <Text>Loading whiteboard…</Text>
      </View>
    );
  }

  return (
    <View onLayout={handleLayout} style={[{ flex: 1 }, style]} testID={testID}>
      <WebView
        key={rendererGeneration}
        ref={webViewRef}
        {...embeddedWhiteboardWebViewSecurityPolicy}
        allowingReadAccessToURL={rendererURL.slice(0, rendererURL.lastIndexOf("/") + 1)}
        mediaPlaybackRequiresUserAction
        onContentProcessDidTerminate={handleRendererTermination}
        onError={(event) => {
          const message = event.nativeEvent.description || "The whiteboard renderer failed to load";
          setLoadError(message);
          handleControllerError({ code: "renderer_load_failed", message, recoverable: true });
        }}
        onMessage={handleMessage}
        onRenderProcessGone={handleRendererTermination}
        onShouldStartLoadWithRequest={allowNavigation}
        originWhitelist={["file://*"]}
        pullToRefreshEnabled={false}
        scrollEnabled={false}
        source={{ uri: sourceURL }}
        style={{ flex: 1 }}
        webviewDebuggingEnabled={typeof __DEV__ !== "undefined" && __DEV__}
      />
      {compatibilityNotice ? (
        <View pointerEvents="none">
          <Text>{compatibilityNotice}</Text>
        </View>
      ) : null}
    </View>
  );
}

function createRendererGeneration(): string {
  return globalThis.crypto?.randomUUID?.() ?? `whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
