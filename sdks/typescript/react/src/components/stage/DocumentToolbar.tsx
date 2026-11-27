import React, { useSyncExternalStore } from "react";
import { useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { ChalkMenu, ChalkMenuItem } from "../chalk-ui";
import { FileTypeBadge } from "./FileTypeBadge";
import { StageIcon } from "./StageIcon";

const iconButton = "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--chalk-on-overlay)] transition hover:bg-[var(--chalk-overlay-hover-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--chalk-on-overlay)] disabled:opacity-40";
const pillButton = "flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-(length:--type-caption) font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--chalk-on-overlay)]";

export interface DocumentToolbarProps {
  readonly documentId: string;
  readonly mine: boolean;
  readonly ready: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly zoom: number;
  readonly thumbnails: boolean;
  readonly fileName: string;
  readonly presenterName: string;
  readonly presenterPage: number;
  readonly browsing: boolean;
  readonly onDownload: () => Promise<void>;
  readonly onThumbnails: () => void;
  readonly onTurn: (page: number) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onReturn: () => void;
  readonly onPresentAnother?: () => void;
}

/** Phones and narrow tiles move page-rail and stop controls into More; the header keeps only what fits. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(max-width: 639px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false,
  );
}

function useStop(documentId: string, mine: boolean) {
  const client = useSpaceClient();
  const self = useSelf();
  return mine || self.can("stopScreenOthers") ? () => void client.presenting.stop(documentId) : null;
}

/** The header over the primary Document: who is presenting, the page, and one More menu. Stop needs presenter rights. */
export function DocumentToolbar(props: DocumentToolbarProps): React.JSX.Element {
  const stop = useStop(props.documentId, props.mine);
  const first = props.presenterName.split(/\s+/)[0] ?? props.presenterName;
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--chalk-overlay-hairline)] pl-3 pr-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)]" role="toolbar" aria-label="Document controls">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {props.mine ? (
          <>
            <FileTypeBadge fileName={props.fileName} className="h-5 min-w-7" />
            <span className="truncate font-semibold">{props.fileName}</span>
          </>
        ) : props.browsing ? (
          <span className="truncate">
            <span className="font-semibold">
              <span className="hidden sm:inline">You're on page </span>
              <span className="sm:hidden">Page </span>
              {props.page}
            </span>
            <span className="hidden opacity-70 sm:inline">
              {" "}
              · {first} is on {props.presenterPage}
            </span>
          </span>
        ) : (
          <>
            <Avatar name={props.presenterName} size="xs" />
            <span className="truncate">
              <span className="font-semibold">{first}</span> <span className="opacity-70">is presenting</span>
            </span>
          </>
        )}
        {props.browsing ? (
          <button type="button" className={cn(pillButton, "bg-[var(--chalk-on-overlay)] text-[var(--chalk-overlay-inverse)] hover:opacity-85")} onClick={props.onReturn}>
            Back to {first}
          </button>
        ) : null}
      </div>
      {props.ready ? <PageControls {...props} /> : null}
      {props.ready ? <DocumentMore {...props} stop={stop} /> : null}
      {stop ? (
        <button type="button" className={cn(pillButton, "ml-1 hidden bg-[var(--chalk-danger)] text-[var(--chalk-on-overlay)] hover:opacity-90 sm:flex")} onClick={stop}>
          Stop presenting
        </button>
      ) : null}
    </div>
  );
}

function PageControls({ page, pageCount, onThumbnails, thumbnails, onTurn }: DocumentToolbarProps): React.JSX.Element {
  return (
    <>
      <button type="button" className={cn(iconButton, "hidden sm:grid")} aria-label="Show pages" aria-pressed={thumbnails} onClick={onThumbnails}>
        <StageIcon name="pages" size={18} />
      </button>
      <button type="button" className={iconButton} aria-label="Previous page" disabled={page <= 1} onClick={() => onTurn(page - 1)}>
        <StageIcon name="chevron-left" size={18} />
      </button>
      <span className="min-w-14 text-center font-semibold tabular-nums" aria-live="polite">
        {page} <span className="font-normal opacity-70">/ {pageCount}</span>
      </span>
      <button type="button" className={iconButton} aria-label="Next page" disabled={page >= pageCount} onClick={() => onTurn(page + 1)}>
        <StageIcon name="chevron-right" size={18} />
      </button>
    </>
  );
}

function DocumentMore({ mine, zoom, onZoom, onThumbnails, onDownload, onPresentAnother, stop }: DocumentToolbarProps & { readonly stop: (() => void) | null }): React.JSX.Element {
  const narrow = useNarrow();
  return (
    <ChalkMenu
      side="bottom"
      className="chalk-device-menu"
      trigger={
        <button type="button" className={iconButton} aria-label="More document options">
          <StageIcon name="more" size={18} />
        </button>
      }
    >
      {narrow ? <ChalkMenuItem onClick={onThumbnails}>All pages</ChalkMenuItem> : null}
      {zoom < 400 ? <ChalkMenuItem onClick={() => onZoom(Math.min(400, zoom + 25))}>{mine ? "Zoom in for everyone" : "Zoom in, only for you"}</ChalkMenuItem> : null}
      {zoom !== 100 ? <ChalkMenuItem onClick={() => onZoom(100)}>Fit page</ChalkMenuItem> : null}
      <ChalkMenuItem onClick={() => void onDownload().catch(() => {})}>Download</ChalkMenuItem>
      {mine && onPresentAnother ? <ChalkMenuItem onClick={onPresentAnother}>Present another file</ChalkMenuItem> : null}
      {narrow && stop ? <ChalkMenuItem onClick={stop}>Stop presenting</ChalkMenuItem> : null}
    </ChalkMenu>
  );
}
