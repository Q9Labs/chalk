import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PictureInPictureWindow } from "../../components/full/picture-in-picture/PictureInPictureWindow";
import type { PictureInPictureControls, PictureInPicturePhase, PictureInPictureSource } from "../../components/full/picture-in-picture/types";

export interface UsePictureInPictureOptions {
  enabled?: boolean;
  autoOpen?: boolean;
  phase: PictureInPicturePhase;
  roomName?: string;
  displayName?: string;
  source: PictureInPictureSource | null;
  previewSource?: PictureInPictureSource | null;
  controls: PictureInPictureControls;
}

export interface UsePictureInPictureReturn {
  isSupported: boolean;
  isActive: boolean;
  phase: PictureInPicturePhase;
  open: () => Promise<void>;
  close: () => Promise<void>;
  toggle: () => Promise<void>;
}

interface DocumentPictureInPictureWindow extends Window {
  document: Document;
}

interface DocumentPictureInPictureApi {
  window?: DocumentPictureInPictureWindow | null;
  requestWindow: (options?: { width?: number; height?: number }) => Promise<DocumentPictureInPictureWindow>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }

  var documentPictureInPicture: DocumentPictureInPictureApi | undefined;
}

const PIP_WIDTH = 420;
const PIP_HEIGHT = 460;

function hasTransientUserActivation() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userActivation = (
    navigator as Navigator & {
      userActivation?: {
        isActive?: boolean;
      };
    }
  ).userActivation;

  return userActivation?.isActive === true;
}

function getDocumentPictureInPictureApi() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.documentPictureInPicture ?? globalThis.documentPictureInPicture;
}

function syncThemeAttributes(targetDocument: Document) {
  const root = document.querySelector("[data-chalk-theme]");
  const theme = root?.getAttribute("data-chalk-theme");

  if (theme) {
    targetDocument.documentElement.setAttribute("data-chalk-theme", theme);
  }

  // Copy dark mode classes and color-scheme from main document
  targetDocument.documentElement.className = document.documentElement.className;
  targetDocument.documentElement.style.cssText = document.documentElement.style.cssText;

  targetDocument.body.style.margin = "0";
  targetDocument.body.style.minHeight = "100vh";
  targetDocument.body.style.background = "var(--background, #050911)";
}

function copyStylesIntoPictureInPicture(targetDocument: Document) {
  targetDocument.head.innerHTML = "";

  for (const node of Array.from(document.head.querySelectorAll("link[rel='stylesheet'], style"))) {
    targetDocument.head.appendChild(node.cloneNode(true));
  }

  syncThemeAttributes(targetDocument);
}

export function usePictureInPicture({ enabled = true, autoOpen = false, phase, roomName, displayName, source, previewSource, controls }: UsePictureInPictureOptions): UsePictureInPictureReturn {
  const [isActive, setIsActive] = useState(false);
  const [isAutoOpenPending, setIsAutoOpenPending] = useState(false);
  const pipWindowRef = useRef<DocumentPictureInPictureWindow | null>(null);
  const pipRootRef = useRef<Root | null>(null);
  const autoOpenAttemptKeyRef = useRef<string | null>(null);

  const api = useMemo(() => getDocumentPictureInPictureApi(), []);
  const isSupported = Boolean(api?.requestWindow);

  const disposePictureInPictureWindow = useCallback(() => {
    const root = pipRootRef.current;
    pipRootRef.current = null;
    pipWindowRef.current = null;
    setIsActive(false);

    if (root) {
      queueMicrotask(() => {
        root.unmount();
      });
    }
  }, []);

  const close = useCallback(async () => {
    const currentWindow = pipWindowRef.current;
    disposePictureInPictureWindow();

    if (currentWindow && !currentWindow.closed) {
      currentWindow.close();
    }
  }, [disposePictureInPictureWindow]);

  const renderPictureInPictureWindow = useCallback(() => {
    const root = pipRootRef.current;
    const pipWindow = pipWindowRef.current;

    if (!root || !pipWindow) {
      return;
    }

    syncThemeAttributes(pipWindow.document);

    root.render(
      <PictureInPictureWindow
        phase={phase}
        roomName={roomName}
        displayName={displayName}
        source={source}
        previewSource={previewSource}
        controls={controls}
        onReturnToTab={() => {
          window.focus();
        }}
      />,
    );
  }, [controls, displayName, phase, previewSource, roomName, source]);

  const open = useCallback(async () => {
    if (!enabled || !api?.requestWindow) {
      return;
    }

    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.focus();
      setIsActive(true);
      return;
    }

    const pipWindow = await api.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
    });

    copyStylesIntoPictureInPicture(pipWindow.document);

    const container = pipWindow.document.createElement("div");
    pipWindow.document.body.appendChild(container);

    pipWindowRef.current = pipWindow;
    pipRootRef.current = createRoot(container);
    setIsActive(true);

    const handlePageHide = () => {
      disposePictureInPictureWindow();
    };

    pipWindow.addEventListener("pagehide", handlePageHide, { once: true });
    renderPictureInPictureWindow();
  }, [api, disposePictureInPictureWindow, enabled, renderPictureInPictureWindow]);

  const attemptAutoOpen = useCallback(async () => {
    if (!enabled || !api?.requestWindow || isActive) {
      setIsAutoOpenPending(false);
      return;
    }

    if (!hasTransientUserActivation()) {
      setIsAutoOpenPending(true);
      return;
    }

    try {
      await open();
      setIsAutoOpenPending(false);
    } catch (error) {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotSupportedError")) {
        setIsAutoOpenPending(error.name === "NotAllowedError");
        return;
      }

      throw error;
    }
  }, [api, enabled, isActive, open]);

  const toggle = useCallback(async () => {
    if (isActive) {
      await close();
      return;
    }

    await open();
  }, [close, isActive, open]);

  useEffect(() => {
    if (!enabled && isActive) {
      void close();
    }
  }, [close, enabled, isActive]);

  useEffect(() => {
    if (!enabled) {
      setIsAutoOpenPending(false);
      autoOpenAttemptKeyRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    autoOpenAttemptKeyRef.current = null;
  }, [phase]);

  useEffect(() => {
    if (!autoOpen || !enabled || !api?.requestWindow || isActive) {
      return;
    }

    const autoOpenAttemptKey = `${phase}:${roomName ?? ""}`;
    if (autoOpenAttemptKeyRef.current === autoOpenAttemptKey) {
      return;
    }

    autoOpenAttemptKeyRef.current = autoOpenAttemptKey;
    void attemptAutoOpen();
  }, [api, attemptAutoOpen, autoOpen, enabled, isActive, phase, roomName]);

  useEffect(() => {
    if (!isAutoOpenPending || !enabled || !api?.requestWindow || isActive) {
      return;
    }

    const handleUserActivation = () => {
      void attemptAutoOpen();
    };

    document.addEventListener("pointerdown", handleUserActivation, true);
    document.addEventListener("keydown", handleUserActivation, true);

    return () => {
      document.removeEventListener("pointerdown", handleUserActivation, true);
      document.removeEventListener("keydown", handleUserActivation, true);
    };
  }, [api, attemptAutoOpen, enabled, isActive, isAutoOpenPending]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    renderPictureInPictureWindow();
  }, [isActive, renderPictureInPictureWindow]);

  useEffect(() => {
    return () => {
      void close();
    };
  }, [close]);

  return {
    isSupported,
    isActive,
    phase,
    open,
    close,
    toggle,
  };
}
