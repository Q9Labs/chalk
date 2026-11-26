import React from "react";
import { useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { StageIcon } from "./StageIcon";

const button = "flex h-9 min-w-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[var(--chalk-on-overlay)] transition hover:bg-[var(--chalk-overlay-hover-fill)] disabled:opacity-40";
const toolbar = "pointer-events-auto flex items-center rounded-full bg-[var(--chalk-overlay-strong)] p-1 text-sm text-[var(--chalk-on-overlay)] shadow-lg outline outline-1 outline-[var(--chalk-overlay-hairline)] backdrop-blur";
const separator = "mx-0.5 h-5 w-px shrink-0 bg-[var(--chalk-overlay-track)]";

export interface DocumentToolbarProps {
  readonly documentId: string;
  readonly mine: boolean;
  readonly ready: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly zoom: number;
  readonly thumbnails: boolean;
  readonly fileName: string;
  readonly downloadUrl?: string;
  readonly onThumbnails: () => void;
  readonly onTurn: (page: number) => void;
  readonly onZoom: (zoom: number) => void;
}

/** The floating control bar for the primary Document. Page and zoom controls need a ready Document; stop needs presenter rights. */
export function DocumentToolbar(props: DocumentToolbarProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const { documentId, mine, ready, downloadUrl, fileName } = props;
  return (
    <div className={toolbar}>
      {ready ? <PageControls {...props} /> : null}
      {!mine && downloadUrl && ready ? (
        <a className={cn(button, "px-3")} href={downloadUrl} download={fileName} aria-label="Download document">
          <StageIcon name="download" size={16} />
          Download
        </a>
      ) : null}
      {mine || self.can("stopScreenOthers") ? (
        <>
          <span className={separator} aria-hidden="true" />
          <button type="button" className={cn(button, "px-3 text-[var(--chalk-overlay-danger)] hover:bg-[var(--chalk-overlay-hover-fill)] hover:opacity-80")} onClick={() => void client.presenting.stop(documentId)}>
            <StageIcon name="close" size={14} />
            Stop showing
          </button>
        </>
      ) : null}
    </div>
  );
}

function PageControls({ page, pageCount, zoom, thumbnails, onThumbnails, onTurn, onZoom }: DocumentToolbarProps): React.JSX.Element {
  return (
    <>
      <button type="button" className={button} aria-label="Toggle page thumbnails" aria-pressed={thumbnails} onClick={onThumbnails}>
        <StageIcon name="file" size={16} />
      </button>
      <span className={separator} aria-hidden="true" />
      <button type="button" className={button} aria-label="Previous page" disabled={page <= 1} onClick={() => onTurn(page - 1)}>
        <StageIcon name="chevron-left" size={16} />
      </button>
      <span className="min-w-16 text-center">
        Page {page} of {pageCount}
      </span>
      <button type="button" className={button} aria-label="Next page" disabled={page >= pageCount} onClick={() => onTurn(page + 1)}>
        <StageIcon name="chevron-right" size={16} />
      </button>
      <span className={separator} aria-hidden="true" />
      <button type="button" className={button} aria-label="Zoom out" disabled={zoom <= 25} onClick={() => onZoom(clampZoom(zoom - 25))}>
        <StageIcon name="zoom-out" size={16} />
      </button>
      <span className="min-w-10 text-center">{zoom}%</span>
      <button type="button" className={button} aria-label="Zoom in" disabled={zoom >= 400} onClick={() => onZoom(clampZoom(zoom + 25))}>
        <StageIcon name="zoom-in" size={16} />
      </button>
      <span className={separator} aria-hidden="true" />
      <button type="button" className={button} aria-label="Fit page" onClick={() => onZoom(100)}>
        <StageIcon name="fit" size={16} />
      </button>
    </>
  );
}

function clampZoom(zoom: number): number {
  return Math.max(25, Math.min(400, zoom));
}
