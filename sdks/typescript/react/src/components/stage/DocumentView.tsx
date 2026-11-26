"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { usePresenting, useSelf, useSpaceClient } from "../../bindings/hooks";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { DocumentPageArea, DocumentPageStrip, DocumentThumbnail } from "./DocumentPages";
import { DocumentToolbar } from "./DocumentToolbar";
import { StageIcon } from "./StageIcon";
import type { StageDocument } from "./stage-items";

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
  const ready = manifest?.status === "ready";
  const pageInfo = manifest?.pages.find((candidate) => candidate.page === page);
  const zoom = mine ? document.zoom : localZoom;
  const fileName = manifest?.fileName ?? document.fileName ?? "Document";
  const presenterName = presenter?.displayName ?? "Presenter";

  const turn = useCallback(
    (next: number) => {
      const bounded = Math.max(1, Math.min(pageCount, next));
      if (mine) void client.presenting.setPage(document.documentId, bounded);
      else setOwnPage(bounded);
    },
    [client, document.documentId, mine, pageCount],
  );

  const zoomTo = useCallback(
    (next: number) => {
      if (mine) void client.presenting.setZoom(document.documentId, next);
      else setLocalZoom(next);
    },
    [client, document.documentId, mine],
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

  const toolbarRef = useRef<HTMLDivElement>(null);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [measurement] Lift the call's notice stack above the floating document toolbar the way the reaction tray lifts it above itself; re-measured whenever the stage rearranges so viewers and presenters stay covered in every layout, and removed when the toolbar unmounts.
  useEffect(() => {
    if (!primary || !interactive) return;
    const bar = toolbarRef.current;
    const frame = bar?.closest<HTMLElement>("[data-part='call-frame']");
    const notices = frame?.querySelector<HTMLElement>("[data-part='toast-stack']");
    if (!bar || !frame || !(notices?.offsetParent instanceof HTMLElement)) return;
    const place = () => {
      if (!(notices.offsetParent instanceof HTMLElement)) return;
      const baseline = notices.offsetParent.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(notices).bottom);
      const lift = `${Math.max(0, baseline - bar.getBoundingClientRect().top + 12)}px`;
      if (frame.style.getPropertyValue("--chalk-reaction-toast-lift") !== lift) frame.style.setProperty("--chalk-reaction-toast-lift", lift);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(bar);
    if (frame instanceof HTMLElement) observer.observe(frame);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      observer.disconnect();
      frame.style.removeProperty("--chalk-reaction-toast-lift");
    };
  });

  if (!primary) {
    return <DocumentThumbnail documentId={document.documentId} fileName={fileName} page={page} ready={ready} imageUrl={pageInfo?.imageUrl} />;
  }

  const pages = manifest?.pages ?? [];
  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[var(--chalk-app-tile-base)] text-[var(--chalk-on-overlay)]" data-document-viewer data-document-id={document.documentId}>
      {thumbnails && ready ? <DocumentPageStrip pages={pages} page={page} onSelect={turn} /> : null}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!mine ? <FollowingNotice following={ownPage === null || ownPage === document.page} presenterName={presenterName} presenterPage={document.page} page={page} onReturn={() => setOwnPage(null)} /> : null}
        <DocumentPageArea manifest={manifest} fileName={fileName} page={page} imageUrl={pageInfo?.imageUrl} zoom={zoom} />
        <div className="absolute bottom-3 left-3 z-20 flex max-w-[45%] items-center gap-1.5 truncate rounded-full bg-[var(--chalk-overlay-strong)] px-3 py-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
          <StageIcon name="file" size={13} />
          <span className="truncate">
            {mine ? "Your PDF" : `${presenterName}'s PDF`} · {fileName}
          </span>
        </div>
        {interactive ? (
          <div className="pointer-events-none z-10 flex justify-center pb-3" ref={toolbarRef}>
            <DocumentToolbar
              documentId={document.documentId}
              mine={mine}
              ready={ready}
              page={page}
              pageCount={pageCount}
              zoom={zoom}
              thumbnails={thumbnails}
              fileName={fileName}
              downloadUrl={pageInfo?.imageUrl ?? pages.find((candidate) => candidate.imageUrl)?.imageUrl}
              onThumbnails={() => setThumbnails((open) => !open)}
              onTurn={turn}
              onZoom={zoomTo}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FollowingNotice({ following, presenterName, presenterPage, page, onReturn }: { readonly following: boolean; readonly presenterName: string; readonly presenterPage: number; readonly page: number; readonly onReturn: () => void }): React.JSX.Element {
  const presenterFirst = presenterName.split(/\s+/)[0] ?? presenterName;
  return (
    <div className="z-10 flex shrink-0 justify-center pb-1 pt-2">
      <div className="flex items-center gap-2 rounded-full bg-[var(--chalk-overlay-strong)] py-1.5 pl-3 pr-1.5 text-(length:--type-caption) text-[var(--chalk-on-overlay)] shadow-lg">
        {following ? (
          <span className="flex items-center gap-1.5 pr-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--chalk-accent)]" aria-hidden="true" />
            Following {presenterFirst} · page {presenterPage}
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <StageIcon name="info" size={13} />
              You're on page {page}
            </span>
            <button type="button" className="rounded-full bg-[var(--chalk-on-overlay)] px-2.5 py-1 font-medium text-[var(--chalk-overlay-inverse)] hover:opacity-85" onClick={onReturn}>
              Back to {presenterFirst}'s page
            </button>
          </>
        )}
      </div>
    </div>
  );
}
