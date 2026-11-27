"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { ChatAttachment, PresentingDocumentManifest, SpaceClient } from "@q9labsai/chalk-client";
import { usePresenting, useSelf, useSpaceClient } from "../../bindings/hooks";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { DocumentPageArea, DocumentPageStrip, DocumentThumbnail } from "./DocumentPages";
import { DocumentToolbar } from "./DocumentToolbar";
import { useDocumentActions } from "./document-actions";
import type { StageDocument } from "./stage-items";

export interface DocumentViewProps {
  readonly document: StageDocument;
  readonly people: readonly Participant[];
  readonly primary: boolean;
  readonly interactive: boolean;
}

export function documentSourceAttachment(manifest: PresentingDocumentManifest): ChatAttachment {
  return { attachmentId: manifest.attachmentId, fileName: manifest.fileName, mimeType: "application/pdf", byteLength: 0 };
}

export async function downloadDocumentSource(client: SpaceClient, manifest: PresentingDocumentManifest, fileName: string): Promise<void> {
  const url = await client.chat.files.resolveUrl(documentSourceAttachment(manifest));
  // Fetch the bytes so cross-origin image/PDF URLs save instead of navigating; the download attribute is ignored there.
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Document download failed (${response.status})`);
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = window.document.createElement("a");
  link.href = blobUrl;
  link.download = fileName;
  window.document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }
}

export function documentKeyTurnEvent(event: Pick<KeyboardEvent, "key" | "target" | "defaultPrevented">): boolean {
  if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]'));
}

/** The lazy Document renderer. Sync owns the presenter's page; browsing away is local viewer state. */
export function DocumentView({ document, people, primary, interactive }: DocumentViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const { presentAnother: onPresentAnother } = useDocumentActions();
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

  const download = useCallback(async () => {
    if (!manifest) throw new Error("The document is not ready.");
    await downloadDocumentSource(client, manifest, fileName);
  }, [client, fileName, manifest]);

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
      if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      turn(document.page + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [document.page, interactive, mine, primary, turn]);

  if (!primary) {
    return <DocumentThumbnail documentId={document.documentId} fileName={fileName} page={page} ready={ready} imageUrl={pageInfo?.imageUrl} />;
  }

  return (
    <PrimaryDocument
      documentId={document.documentId}
      manifest={manifest}
      fileName={fileName}
      page={page}
      pageCount={pageCount}
      pageImageUrl={pageInfo?.imageUrl}
      zoom={zoom}
      mine={mine}
      ready={ready}
      interactive={interactive}
      thumbnails={thumbnails}
      following={ownPage === null || ownPage === document.page}
      presenterName={presenterName}
      presenterPage={document.page}
      onThumbnails={() => setThumbnails((open) => !open)}
      onReturn={() => setOwnPage(null)}
      onPresentAnother={mine ? onPresentAnother : undefined}
      onClose={() => void client.presenting.stop(document.documentId)}
      onTurn={turn}
      onZoom={zoomTo}
      onDownload={download}
    />
  );
}

interface PrimaryDocumentProps {
  readonly documentId: string;
  readonly manifest: PresentingDocumentManifest | undefined;
  readonly fileName: string;
  readonly page: number;
  readonly pageCount: number;
  readonly pageImageUrl: string | undefined;
  readonly zoom: number;
  readonly mine: boolean;
  readonly ready: boolean;
  readonly interactive: boolean;
  readonly thumbnails: boolean;
  readonly following: boolean;
  readonly presenterName: string;
  readonly presenterPage: number;
  readonly onPresentAnother?: () => void;
  readonly onClose: () => void;
  readonly onDownload: () => Promise<void>;
  readonly onThumbnails: () => void;
  readonly onReturn: () => void;
  readonly onTurn: (page: number) => void;
  readonly onZoom: (zoom: number) => void;
}

/** The Document as the Stage's primary tile: control header, optional page rail, and the page. */
function PrimaryDocument(props: PrimaryDocumentProps): React.JSX.Element {
  const pages = props.manifest?.pages ?? [];
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-tile-base)] text-[var(--chalk-on-overlay)]" data-document-viewer data-document-id={props.documentId}>
      {props.interactive ? (
        <DocumentToolbar
          documentId={props.documentId}
          mine={props.mine}
          ready={props.ready}
          page={props.page}
          pageCount={props.pageCount}
          zoom={props.zoom}
          thumbnails={props.thumbnails}
          fileName={props.fileName}
          presenterName={props.presenterName}
          presenterPage={props.presenterPage}
          browsing={!props.following}
          onDownload={props.onDownload}
          onThumbnails={props.onThumbnails}
          onTurn={props.onTurn}
          onZoom={props.onZoom}
          onReturn={props.onReturn}
          onPresentAnother={props.onPresentAnother}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        {props.thumbnails && props.ready ? <DocumentPageStrip pages={pages} page={props.page} onSelect={props.onTurn} /> : null}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <DocumentPageArea manifest={props.manifest} fileName={props.fileName} page={props.page} imageUrl={props.pageImageUrl} zoom={props.zoom} mine={props.mine} presenterName={props.presenterName} onClose={props.onClose} onChooseAnother={props.onPresentAnother} />
        </div>
      </div>
    </div>
  );
}
