import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVideoTrack } from "../participant-tile/useVideoTrack";
import { ScreenAnnotationLayer, type ScreenAnnotationLayerProps } from "./ScreenAnnotationLayer";
import { annotationControl } from "./AnnotationAccess";

interface DocumentPiP {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

function hasDocumentPiP(window: Window): window is Window & { documentPictureInPicture: DocumentPiP } {
  return "documentPictureInPicture" in window && typeof window.documentPictureInPicture === "object" && window.documentPictureInPicture !== null && "requestWindow" in window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === "function";
}

type PictureProps = Pick<ScreenAnnotationLayerProps, "client" | "state" | "presence" | "renderer"> & { readonly track: MediaStreamTrack };

export function AnnotationPictureInPicture(props: PictureProps): React.JSX.Element {
  const [popup, setPopup] = useState<Window | null>(null);
  const [opening, setOpening] = useState(false);
  const [denied, setDenied] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const current = useRef<Window | null>(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] A pending or open PiP belongs only to this live publication.
  useEffect(
    () => () => {
      pending.current?.abort();
      current.current?.close();
    },
    [],
  );

  if (typeof window === "undefined" || !hasDocumentPiP(window)) return <span className={annotationControl}>Marks are visible in this tab</span>;
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
      view.document.body.style.margin = "0";
      view.document.body.style.background = "#101116";
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
      <button type="button" className={annotationControl} disabled={opening} onClick={() => void open()}>
        {popup ? "Close marks preview" : "Pop out marks"}
      </button>
      {denied ? (
        <span role="status" className={annotationControl}>
          Couldn’t pop out. Marks are visible in this tab.
        </span>
      ) : null}
      {popup ? createPortal(<Picture {...props} />, popup.document.body) : null}
    </>
  );
}

function Picture({ track, ...props }: PictureProps): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  useVideoTrack(video, track, true);
  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", position: "relative" }}>
      <video ref={video} muted autoPlay playsInline aria-label="Shared screen" style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
      <ScreenAnnotationLayer {...props} videoRef={video} fit="fit" />
      <span style={{ position: "absolute", bottom: 8, left: 8, borderRadius: 10, background: "#101116", color: "white", padding: "5px 9px", font: "12px system-ui" }}>Chalk · Live marks</span>
    </div>
  );
}
