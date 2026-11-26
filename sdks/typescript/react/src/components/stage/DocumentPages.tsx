import React from "react";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { cn } from "../../utils/cn";

type DocumentPage = PresentingDocumentManifest["pages"][number];

/** The side-strip tile for a Document that is not primary: a bare page thumbnail. */
export function DocumentThumbnail({ documentId, fileName, page, ready, imageUrl }: { readonly documentId: string; readonly fileName: string; readonly page: number; readonly ready: boolean; readonly imageUrl?: string }): React.JSX.Element {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--chalk-app-tile-base)] p-1.5 text-[var(--chalk-on-overlay)]" data-document-viewer data-document-id={documentId}>
      {ready && imageUrl ? <img src={imageUrl} alt={`${fileName}, page ${page}`} draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="grid h-9 w-8 place-items-center rounded-md bg-[var(--chalk-file-pdf)] text-[10px] font-bold">PDF</span>}
    </div>
  );
}

export function DocumentPageStrip({ pages, page, onSelect }: { readonly pages: readonly DocumentPage[]; readonly page: number; readonly onSelect: (page: number) => void }): React.JSX.Element {
  return (
    <div className="z-10 flex w-34 shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--chalk-overlay-hairline)] bg-[var(--chalk-overlay-scrim-faint)] p-2">
      {pages.map((candidate) => (
        <button
          key={candidate.page}
          type="button"
          onClick={() => onSelect(candidate.page)}
          aria-current={candidate.page === page ? "page" : undefined}
          className={cn("rounded-md border p-1", candidate.page === page ? "border-[var(--chalk-on-overlay)]" : "border-[var(--chalk-overlay-hairline)] opacity-75 hover:opacity-100")}
        >
          {candidate.thumbnailUrl ? (
            <img src={candidate.thumbnailUrl} alt="" className="aspect-[8.5/11] w-full rounded-sm object-contain bg-[var(--chalk-on-overlay)]" />
          ) : (
            <div className="grid aspect-[8.5/11] place-items-center bg-[var(--chalk-overlay-hover-fill)] text-xs">{candidate.page}</div>
          )}
        </button>
      ))}
    </div>
  );
}

export function DocumentPageArea({ manifest, fileName, page, imageUrl, zoom }: { readonly manifest?: PresentingDocumentManifest; readonly fileName: string; readonly page: number; readonly imageUrl?: string; readonly zoom: number }): React.JSX.Element {
  const content = <PageContent page={page} imageUrl={imageUrl} fileName={fileName} zoom={zoom} />;
  return (
    <div className="relative min-h-0 flex-1">
      {manifest?.status === "preparing" || !manifest ? (
        <DocumentPreparing manifest={manifest} fileName={fileName} />
      ) : manifest.status === "failed" ? (
        <div className="grid h-full place-items-center p-4">
          <div role="alert" className="rounded-2xl bg-[var(--chalk-overlay-scrim-soft)] p-5 text-sm">
            This document could not be prepared.
          </div>
        </div>
      ) : zoom === 100 ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">{content}</div>
      ) : (
        <div className="absolute inset-0 overflow-auto p-4">{content}</div>
      )}
    </div>
  );
}

function DocumentPreparing({ manifest, fileName }: { readonly manifest?: PresentingDocumentManifest; readonly fileName: string }): React.JSX.Element {
  const percent = preparedPercent(manifest);
  return (
    <div className="grid h-full place-items-center p-4">
      <div role="status" className="flex w-80 items-center gap-3 rounded-2xl bg-[var(--chalk-overlay-scrim-soft)] p-4 shadow-lg">
        <span className="grid h-9 w-8 shrink-0 place-items-center rounded-md bg-[var(--chalk-file-pdf)] text-[10px] font-bold text-[var(--chalk-on-overlay)]">PDF</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            Preparing {fileName}
            {percent !== null ? ` · ${percent}%` : ""}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--chalk-overlay-track)]">
            <div className="h-full rounded-full bg-[var(--chalk-overlay-track-fill)]" style={{ width: `${percent ?? 35}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PageContent({ page, imageUrl, fileName, zoom }: { readonly page: number; readonly imageUrl?: string; readonly fileName: string; readonly zoom: number }): React.JSX.Element {
  if (!imageUrl) {
    return (
      <div role="status" className="rounded-xl bg-[var(--chalk-overlay-scrim-soft)] px-4 py-3 text-sm">
        Page {page} is still being prepared
      </div>
    );
  }
  const fit = zoom === 100;
  return <img src={imageUrl} alt={`${fileName}, page ${page}`} draggable={false} className={fit ? "h-full w-full object-contain shadow-2xl" : "max-w-none shrink-0 shadow-2xl"} style={fit ? undefined : { width: `${zoom}%` }} />;
}

function preparedPercent(manifest?: PresentingDocumentManifest): number | null {
  if (!manifest || manifest.status !== "preparing" || !manifest.pageCount) return null;
  const readyPages = manifest.pages.filter((candidate) => candidate.status === "ready").length;
  return Math.max(1, Math.round((readyPages / manifest.pageCount) * 100));
}
