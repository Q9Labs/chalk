import { PictureInPictureOnIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChalkTooltip } from "../chalk-ui";
import { useVideoTrack } from "../participant-tile/useVideoTrack";
import { ScreenAnnotationLayer, type ScreenAnnotationLayerProps } from "./ScreenAnnotationLayer";
import { PIP_CSS } from "./AnnotationStyles";

interface DocumentPiP {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

function hasDocumentPiP(window: Window): window is Window & { documentPictureInPicture: DocumentPiP } {
  return "documentPictureInPicture" in window && typeof window.documentPictureInPicture === "object" && window.documentPictureInPicture !== null && "requestWindow" in window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === "function";
}

type PictureProps = Pick<ScreenAnnotationLayerProps, "client" | "state" | "presence" | "fontUrl"> & { readonly track: MediaStreamTrack };

// The window has no app CSS, so it borrows the call's own token values.
const hostTokens = ["--chalk-stage", "--chalk-overlay-strong", "--chalk-overlay-warning", "--chalk-on-overlay", "--chalk-positive", "--chalk-shadow", "--type-caption"] as const;

function styleWindow(view: Window): void {
  const host = getComputedStyle(document.querySelector("[data-chalk]") ?? document.documentElement);
  for (const token of hostTokens) view.document.documentElement.style.setProperty(token, host.getPropertyValue(token));
  const sheet = view.document.createElement("style");
  sheet.textContent = PIP_CSS;
  view.document.head.append(sheet);
}

export function AnnotationPictureInPicture({ inTab, hints = false, ...props }: PictureProps & { readonly inTab: boolean; readonly hints?: boolean }): React.JSX.Element {
  const [popup, setPopup] = useState<Window | null>(null);
  const [opening, setOpening] = useState(false);
  const [denied, setDenied] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const current = useRef<Window | null>(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] A pending or open PiP belongs only to this live publication.
  useEffect(
    () => () => {
      pending.current?.abort();
      const view = current.current;
      current.current = null;
      view?.close();
    },
    [],
  );

  if (typeof window === "undefined" || !hasDocumentPiP(window)) return <span className="chalk-ann-status">{inTab ? "Marks are visible in this tab" : "Share a tab to see marks in this call"}</span>;
  const pip = window.documentPictureInPicture;
  const open = async () => {
    if (current.current) {
      current.current.close();
      return;
    }
    if (pending.current) return;
    const attempt = new AbortController();
    pending.current = attempt;
    setOpening(true);
    setDenied(false);
    try {
      const view = await pip.requestWindow({ width: 480, height: 320 });
      if (attempt.signal.aborted) {
        view.close();
        return;
      }
      current.current = view;
      view.addEventListener(
        "pagehide",
        () => {
          if (current.current === view) {
            current.current = null;
            setPopup(null);
          }
        },
        { once: true },
      );
      view.document.title = "Chalk · Shared screen";
      styleWindow(view);
      setPopup(view);
    } catch {
      if (!attempt.signal.aborted) setDenied(true);
    } finally {
      if (!attempt.signal.aborted) setOpening(false);
      pending.current = null;
    }
  };
  return (
    <>
      <ChalkTooltipIf hint={hints ? "Pop out marks" : undefined}>
        <button type="button" className="chalk-ann-btn" disabled={opening} onClick={() => void open()}>
          <HugeiconsIcon icon={PictureInPictureOnIcon} size={16} aria-hidden="true" />
          <span className="chalk-ann-label">{popup ? "Close marks preview" : "Pop out marks"}</span>
        </button>
      </ChalkTooltipIf>
      {denied ? (
        <span role="status" className="chalk-ann-status">
          {inTab ? "Couldn’t pop out. Marks are visible in this tab." : "Couldn’t pop out. Share a tab to see marks in this call."}
        </span>
      ) : null}
      {popup ? createPortal(<Picture {...props} />, popup.document.body) : null}
    </>
  );
}

function ChalkTooltipIf({ hint, children }: { readonly hint?: string; readonly children: React.JSX.Element }) {
  return hint ? <ChalkTooltip trigger={children}>{hint}</ChalkTooltip> : children;
}

function Picture({ track, ...props }: PictureProps): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  useVideoTrack(video, track, true);
  const paused = props.state.paused;
  return (
    <div className="chalk-ann-pip">
      <video ref={video} muted autoPlay playsInline aria-label="Shared screen" />
      <ScreenAnnotationLayer {...props} videoRef={video} track={track} fit="fit" />
      <span className="chalk-ann-pip-status" data-paused={paused ? "" : undefined}>
        <i aria-hidden="true" />
        {paused ? "Marks paused" : "Live marks"}
      </span>
    </div>
  );
}
