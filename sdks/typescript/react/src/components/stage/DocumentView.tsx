"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { usePresenting, useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { StageIcon } from "./StageIcon";
import type { StageDocument } from "./stage-items";

const button = "grid h-8 min-w-8 place-items-center rounded-full px-2 text-[var(--chalk-on-overlay)] transition hover:bg-white/10 disabled:opacity-40";
const toolbar = "pointer-events-auto flex items-center gap-1 rounded-full bg-[var(--chalk-overlay-strong)] p-1 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg outline outline-1 outline-white/10 backdrop-blur";

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

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[#202124] text-white" data-document-viewer data-document-id={document.documentId}>
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
      <div className="relative min-w-0 flex-1 overflow-auto">
        <div className="grid h-full min-h-full place-items-center p-4">
          {manifest?.status === "preparing" || !manifest ? (
            <div role="status" className="w-72 rounded-2xl bg-black/45 p-5 text-center shadow-lg">
              <div className="text-sm font-medium">Preparing {fileName}</div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15">
                <div className="h-full w-2/3 rounded-full bg-white/70" />
              </div>
            </div>
          ) : manifest.status === "failed" ? (
            <div role="alert" className="rounded-2xl bg-black/45 p-5 text-sm">
              This document could not be prepared.
            </div>
          ) : pageInfo?.imageUrl ? (
            <img src={zoom > 125 ? pageInfo.imageUrl : pageInfo.imageUrl} alt={`${fileName}, page ${page}`} draggable={false} className="max-h-full max-w-full object-contain shadow-2xl" style={zoom === 100 ? undefined : { maxWidth: `${zoom}%`, width: `${zoom}%` }} />
          ) : (
            <div role="status" className="rounded-xl bg-black/40 px-4 py-3 text-sm">
              Page {page} is still being prepared
            </div>
          )}
        </div>
      </div>
      <div className="absolute left-3 top-3 z-20 max-w-[45%] truncate rounded-full bg-[var(--chalk-overlay-strong)] px-3 py-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
        {mine ? "Your PDF" : `${presenterFirst}'s PDF`} · {fileName}
      </div>
      {!mine && (
        <div className="absolute bottom-3 left-3 z-20 rounded-full bg-[var(--chalk-overlay-strong)] px-3 py-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
          {following ? (
            <span>
              Following {presenterFirst} · page {document.page}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              You're on page {page}
              <button type="button" className="rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/25" onClick={() => setOwnPage(null)}>
                Back to {presenterFirst}'s page
              </button>
            </span>
          )}
        </div>
      )}
      {primary && interactive ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <div className={toolbar}>
            <button type="button" className={button} aria-label="Toggle page thumbnails" aria-pressed={thumbnails} onClick={() => setThumbnails((open) => !open)}>
              <StageIcon name="file" size={16} />
            </button>
            <button type="button" className={button} aria-label="Previous page" disabled={page <= 1} onClick={() => turn(page - 1)}>
              <StageIcon name="chevron-left" size={16} />
            </button>
            <span className="min-w-16 text-center">
              Page {page} of {pageCount}
            </span>
            <button type="button" className={button} aria-label="Next page" disabled={page >= pageCount} onClick={() => turn(page + 1)}>
              <StageIcon name="chevron-right" size={16} />
            </button>
            <button type="button" className={button} aria-label="Zoom out" disabled={zoom <= 25} onClick={() => changeZoom(mine ? document.zoom : localZoom, -25, mine, document.documentId, client.presenting.setZoom, setLocalZoom)}>
              <StageIcon name="zoom-out" size={16} />
            </button>
            <span className="min-w-10 text-center">{zoom}%</span>
            <button type="button" className={button} aria-label="Zoom in" disabled={zoom >= 400} onClick={() => changeZoom(mine ? document.zoom : localZoom, 25, mine, document.documentId, client.presenting.setZoom, setLocalZoom)}>
              <StageIcon name="zoom-in" size={16} />
            </button>
            <button type="button" className={button} aria-label="Fit page" onClick={() => (mine ? void client.presenting.setZoom(document.documentId, 100) : setLocalZoom(100))}>
              <StageIcon name="fit" size={16} />
            </button>
            {downloadUrl ? (
              <a className={button} href={downloadUrl} download={fileName} aria-label="Download document">
                <StageIcon name="download" size={16} />
              </a>
            ) : null}
            {mine || self.can("stopScreenOthers") ? (
              <button type="button" className={cn(button, "bg-red-500/80 hover:bg-red-500")} onClick={() => void client.presenting.stop(document.documentId)}>
                Stop showing
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function changeZoom(current: number, delta: number, presenter: boolean, documentId: string, setZoom: (documentId: string, zoom: number) => Promise<unknown>, setLocalZoom: (zoom: number) => void): void {
  const next = Math.max(25, Math.min(400, current + delta));
  if (presenter) void setZoom(documentId, next);
  else setLocalZoom(next);
}
