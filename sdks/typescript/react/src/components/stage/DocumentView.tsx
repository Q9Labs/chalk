"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { usePresenting, useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { StageIcon } from "./StageIcon";
import type { StageDocument } from "./stage-items";

const button = "flex h-9 min-w-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[var(--chalk-on-overlay)] transition hover:bg-white/10 disabled:opacity-40";
const toolbar = "pointer-events-auto flex items-center rounded-full bg-[var(--chalk-overlay-strong)] p-1 text-sm text-[var(--chalk-on-overlay)] shadow-lg outline outline-1 outline-white/10 backdrop-blur";
const separator = "mx-0.5 h-5 w-px shrink-0 bg-white/15";

export interface DocumentViewProps {
  readonly document: StageDocument;
  readonly people: readonly Participant[];
  readonly primary: boolean;
  readonly interactive: boolean;
}

/** The lazy Document renderer. Sync owns the presenter's page; browsing away is local viewer state. */
export function DocumentView({ document, people, primary, interactive }: DocumentViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const presenting = usePresenting();
  const manifest = presenting.manifests[document.documentId] as PresentingDocumentManifest | undefined;
  const presenter = people.find((person) => person.id === document.presenterId);
  const mine = self.participantId === document.presenterId;
  const [ownPage, setOwnPage] = useState<number | null>(null);
  const [thumbnails, setThumbnails] = useState(false);
  const [localZoom, setLocalZoom] = useState(document.zoom);
  const pageCount = manifest?.pageCount ?? document.pageCount ?? Math.max(1, document.page);
  const page = ownPage ?? document.page;
  const following = ownPage === null || ownPage === document.page;
  const ready = manifest?.status === "ready";
  const pageInfo = manifest?.pages.find((candidate) => candidate.page === page);
  const zoom = mine ? document.zoom : localZoom;

  const turn = useCallback(
    (next: number) => {
      const bounded = Math.max(1, Math.min(pageCount, next));
      if (mine) void client.presenting.setPage(document.documentId, bounded);
      else setOwnPage(bounded);
    },
    [client, document.documentId, mine, pageCount],
  );

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Arrow keys are the presenter-only page-turn shortcut while the Document is primary; removed with the tile.
  useEffect(() => {
    if (!mine || !primary || !interactive) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      turn(document.page + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [document.page, interactive, mine, primary, turn]);

  const presenterName = presenter?.displayName ?? "Presenter";
  const presenterFirst = presenterName.split(/\s+/)[0] ?? presenterName;
  const fileName = manifest?.fileName ?? document.fileName ?? "Document";
  const downloadUrl = pageInfo?.imageUrl ?? manifest?.pages.find((candidate) => candidate.imageUrl)?.imageUrl;
  const pages = useMemo(() => manifest?.pages ?? [], [manifest?.pages]);
  const preparedPercent = useMemo(() => {
    if (!manifest || manifest.status !== "preparing" || !manifest.pageCount) return null;
    const readyPages = pages.filter((candidate) => candidate.status === "ready").length;
    return Math.max(1, Math.round((readyPages / manifest.pageCount) * 100));
  }, [manifest, pages]);

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[var(--chalk-app-tile-base)] text-[var(--chalk-on-overlay)]" data-document-viewer data-document-id={document.documentId}>
      {thumbnails && ready ? (
        <div className="z-10 flex w-[136px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-white/10 bg-black/25 p-2">
          {pages.map((candidate) => (
            <button
              key={candidate.page}
              type="button"
              onClick={() => (mine ? turn(candidate.page) : setOwnPage(candidate.page))}
              aria-current={candidate.page === page ? "page" : undefined}
              className={cn("rounded-md border p-1", candidate.page === page ? "border-white" : "border-white/15 opacity-75 hover:opacity-100")}
            >
              {candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" className="aspect-[8.5/11] w-full rounded-sm object-contain bg-white" /> : <div className="grid aspect-[8.5/11] place-items-center bg-white/10 text-xs">{candidate.page}</div>}
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
          {manifest?.status === "preparing" || !manifest ? (
            <div role="status" className="flex w-80 items-center gap-3 rounded-2xl bg-black/45 p-4 shadow-lg">
              <span className="grid h-9 w-8 shrink-0 place-items-center rounded-md bg-red-500 text-[10px] font-bold text-white">PDF</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  Preparing {fileName}
                  {preparedPercent !== null ? ` · ${preparedPercent}%` : ""}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15">
                  <div className="h-full rounded-full bg-white/70" style={{ width: `${preparedPercent ?? 35}%` }} />
                </div>
              </div>
            </div>
          ) : manifest.status === "failed" ? (
            <div role="alert" className="rounded-2xl bg-black/45 p-5 text-sm">
              This document could not be prepared.
            </div>
          ) : pageInfo?.imageUrl ? (
            <img
              src={pageInfo.imageUrl}
              alt={`${fileName}, page ${page}`}
              draggable={false}
              className={zoom === 100 ? "max-h-full max-w-full object-contain shadow-2xl" : "max-w-none shrink-0 shadow-2xl"}
              style={zoom === 100 ? undefined : { width: `${zoom}%` }}
            />
          ) : (
            <div role="status" className="rounded-xl bg-black/40 px-4 py-3 text-sm">
              Page {page} is still being prepared
            </div>
          )}
        </div>
      <div className="absolute bottom-3 left-3 z-20 flex max-w-[45%] items-center gap-1.5 truncate rounded-full bg-[var(--chalk-overlay-strong)] px-3 py-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
        <StageIcon name="file" size={13} />
        <span className="truncate">{mine ? "Your PDF" : `${presenterName}'s PDF`} · {fileName}</span>
      </div>
      {!mine && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--chalk-overlay-strong)] py-1.5 pl-3 pr-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
          {following ? (
            <span className="flex items-center gap-1.5 pr-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
              Following {presenterFirst} · page {document.page}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <StageIcon name="info" size={13} />
                You're on page {page}
              </span>
              <button type="button" className="rounded-full bg-white px-2.5 py-1 font-medium text-black hover:bg-white/85" onClick={() => setOwnPage(null)}>
                Back to {presenterFirst}'s page
              </button>
            </>
          )}
        </div>
      )}
      {primary && interactive ? (
        <div className="pointer-events-none z-10 flex justify-center pb-3">
          <div className={toolbar}>
            {ready ? (
            <>
            <button type="button" className={button} aria-label="Toggle page thumbnails" aria-pressed={thumbnails} onClick={() => setThumbnails((open) => !open)}>
              <StageIcon name="file" size={16} />
            </button>
            <span className={separator} aria-hidden="true" />
            <button type="button" className={button} aria-label="Previous page" disabled={page <= 1} onClick={() => turn(page - 1)}>
              <StageIcon name="chevron-left" size={16} />
            </button>
            <span className="min-w-16 text-center">
              Page {page} of {pageCount}
            </span>
            <button type="button" className={button} aria-label="Next page" disabled={page >= pageCount} onClick={() => turn(page + 1)}>
              <StageIcon name="chevron-right" size={16} />
            </button>
            <span className={separator} aria-hidden="true" />
            <button type="button" className={button} aria-label="Zoom out" disabled={zoom <= 25} onClick={() => changeZoom(mine ? document.zoom : localZoom, -25, mine, document.documentId, client.presenting.setZoom, setLocalZoom)}>
              <StageIcon name="zoom-out" size={16} />
            </button>
            <span className="min-w-10 text-center">{zoom}%</span>
            <button type="button" className={button} aria-label="Zoom in" disabled={zoom >= 400} onClick={() => changeZoom(mine ? document.zoom : localZoom, 25, mine, document.documentId, client.presenting.setZoom, setLocalZoom)}>
              <StageIcon name="zoom-in" size={16} />
            </button>
            <span className={separator} aria-hidden="true" />
            <button type="button" className={button} aria-label="Fit page" onClick={() => (mine ? void client.presenting.setZoom(document.documentId, 100) : setLocalZoom(100))}>
              <StageIcon name="fit" size={16} />
            </button>
            </>
            ) : null}
            {downloadUrl && ready ? (
              <a className={cn(button, "px-3")} href={downloadUrl} download={fileName} aria-label="Download document">
                <StageIcon name="download" size={16} />
                Download
              </a>
            ) : null}
            {mine || self.can("stopScreenOthers") ? (
              <>
              <span className={separator} aria-hidden="true" />
              <button type="button" className={cn(button, "px-3 text-red-400 hover:bg-white/10 hover:text-red-300")} onClick={() => void client.presenting.stop(document.documentId)}>
                <StageIcon name="close" size={14} />
                Stop showing
              </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}

function changeZoom(current: number, delta: number, presenter: boolean, documentId: string, setZoom: (documentId: string, zoom: number) => Promise<unknown>, setLocalZoom: (zoom: number) => void): void {
  const next = Math.max(25, Math.min(400, current + delta));
  if (presenter) void setZoom(documentId, next);
  else setLocalZoom(next);
}
