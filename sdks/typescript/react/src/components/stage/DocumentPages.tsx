import React from "react";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { cn } from "../../utils/cn";
import { StageIcon } from "./StageIcon";

type DocumentPage = PresentingDocumentManifest["pages"][number];

/** The side-strip tile for a Document that is not primary: a bare page thumbnail. */
export function DocumentThumbnail({ documentId, fileName, page, ready, imageUrl }: { readonly documentId: string; readonly fileName: string; readonly page: number; readonly ready: boolean; readonly imageUrl?: string }): React.JSX.Element {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--chalk-app-tile-base)] p-1.5 text-[var(--chalk-on-overlay)]" data-document-viewer data-document-id={documentId}>
      {ready && imageUrl ? <img src={imageUrl} alt={`${fileName}, page ${page}`} draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="grid h-9 w-8 place-items-center rounded-md bg-[var(--chalk-file-pdf)] text-(length:--type-micro) font-bold">PDF</span>}
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
          {candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" className="aspect-[8.5/11] w-full rounded-sm object-contain bg-[var(--chalk-on-overlay)]" /> : <div className="grid aspect-[8.5/11] place-items-center bg-[var(--chalk-overlay-hover-fill)] text-xs">{candidate.page}</div>}
        </button>
      ))}
    </div>
  );
}

export function DocumentPageArea({
  manifest,
  fileName,
  page,
  imageUrl,
  zoom,
  mine,
  presenterName,
  onClose,
  onChooseAnother,
}: {
  readonly manifest?: PresentingDocumentManifest;
  readonly fileName: string;
  readonly page: number;
  readonly imageUrl?: string;
  readonly zoom: number;
  readonly mine: boolean;
  readonly presenterName: string;
  readonly onClose: () => void;
  readonly onChooseAnother?: () => void;
}): React.JSX.Element {
  const content = <PageContent page={page} imageUrl={imageUrl} fileName={fileName} zoom={zoom} />;
  return (
    <div className="relative min-h-0 flex-1">
      {manifest?.status === "preparing" || !manifest ? (
        <DocumentPreparing manifest={manifest} fileName={fileName} mine={mine} presenterName={presenterName} />
      ) : manifest.status === "failed" ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div role="alert" className="flex max-w-80 flex-col items-center gap-1.5 text-center">
            <StageIcon name="info" size={22} />
            <h3 className="mt-1.5 text-[15px] font-semibold">Couldn't open {fileName}</h3>
            <p className="text-(length:--type-caption) opacity-70">It may be password protected or damaged. Nobody else saw it.</p>
            <div className="mt-2.5 flex gap-2">
              <button type="button" className="flex h-8 items-center rounded-full bg-[var(--chalk-overlay-hover-fill)] px-3 text-(length:--type-caption) font-medium" onClick={onClose}>
                Close
              </button>
              {onChooseAnother ? (
                <button type="button" className="flex h-8 items-center rounded-full bg-[var(--chalk-on-overlay)] px-3 text-(length:--type-caption) font-medium text-[var(--chalk-overlay-inverse)]" onClick={onChooseAnother}>
                  Choose another file
                </button>
              ) : null}
            </div>
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

function DocumentPreparing({ manifest, fileName, mine, presenterName }: { readonly manifest?: PresentingDocumentManifest; readonly fileName: string; readonly mine: boolean; readonly presenterName: string }): React.JSX.Element {
  const percent = preparedPercent(manifest);
  const first = presenterName.split(/\s+/)[0] ?? presenterName;
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="relative h-full max-w-full overflow-hidden rounded-sm bg-[var(--chalk-overlay-scrim-faint)]" style={{ aspectRatio: "850 / 1100" }} aria-hidden="true">
        {[12, 20, 28, 36, 44, 52, 60, 68].map((top) => (
          <i key={top} className="absolute left-[12%] right-[12%] h-2.5 animate-pulse rounded-full bg-[var(--chalk-overlay-hover-fill)]" style={{ top: `${top}%` }} />
        ))}
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <div role="status" className="flex max-w-[80%] flex-col items-center gap-2.5 rounded-2xl bg-[var(--chalk-overlay-strong)] px-5 py-4 text-center">
          <span className="h-[22px] w-[22px] animate-spin rounded-full border-[2.5px] border-[var(--chalk-overlay-track)] border-t-[var(--chalk-on-overlay)]" aria-hidden="true" />
          <b className="text-sm font-semibold">{mine ? "Preparing your file" : `${first} is opening a file`}</b>
          <span className="text-(length:--type-caption) opacity-70">{mine ? "Everyone sees page 1 as soon as it's ready" : fileName}</span>
          {mine ? (
            <div className="h-1 w-44 overflow-hidden rounded-full bg-[var(--chalk-overlay-track)]">
              <div className="h-full rounded-full bg-[var(--chalk-overlay-track-fill)] transition-[width]" style={{ width: `${Math.max(8, percent ?? 8)}%` }} />
            </div>
          ) : null}
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
