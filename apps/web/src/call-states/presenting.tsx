import { presentingFormatIdsFor, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { Live } from "./live";
import { liveSnapshot, PEOPLE, type Person } from "./fixtures";
import page01 from "./presenting-pages/page-01.webp";
import page02 from "./presenting-pages/page-02.webp";
import page03 from "./presenting-pages/page-03.webp";
import page04 from "./presenting-pages/page-04.webp";
import page05 from "./presenting-pages/page-05.webp";
import page06 from "./presenting-pages/page-06.webp";
import page07 from "./presenting-pages/page-07.webp";
import page08 from "./presenting-pages/page-08.webp";
import page09 from "./presenting-pages/page-09.webp";
import page10 from "./presenting-pages/page-10.webp";
import page11 from "./presenting-pages/page-11.webp";
import page12 from "./presenting-pages/page-12.webp";

const nora: Person = PEOPLE[0]!;

// Real rendered pages from the prototype's sample worksheet, so fixture shots read as a document.
const RENDERED_PAGES = [page01, page02, page03, page04, page05, page06, page07, page08, page09, page10, page11, page12];

function pages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    width: 850,
    height: 1100,
    status: "ready" as const,
    imageUrl: RENDERED_PAGES[index % RENDERED_PAGES.length]!,
    thumbnailUrl: RENDERED_PAGES[index % RENDERED_PAGES.length]!,
  }));
}

type PresentingFixtureOptions = {
  readonly presenter: "self" | "nora";
  readonly page?: number;
  readonly zoom?: number;
  readonly status?: "preparing" | "ready";
  readonly screenShare?: boolean;
};

function presentingSnapshot(options: PresentingFixtureOptions): SpaceSnapshot {
  const presenterId = options.presenter === "self" ? "you" : nora.id;
  const documentId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
  const status = options.status ?? "ready";
  const pageCount = 12;
  const base = liveSnapshot({
    others: options.presenter === "self" ? [{ ...nora, sharing: options.screenShare === true }] : options.screenShare ? [{ ...nora, sharing: true }] : [nora],
  });
  return {
    ...base,
    presenting: {
      status: "ready",
      available: true,
      formats: presentingFormatIdsFor(),
      revision: 3,
      documents: [{ documentId, presenterId, page: options.page ?? 3, zoom: options.zoom ?? 100, startedAtMs: Date.now() - 60_000 }],
      manifests: {
        [documentId]: {
          documentId,
          attachmentId: "attachment-1",
          fileName: "Algebra worksheet.pdf",
          status,
          pageCount: status === "ready" ? pageCount : undefined,
          pages: status === "ready" ? pages(pageCount) : [],
        },
      },
    },
  };
}

export function PresenterState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", page: 3 })} />;
}

export function ViewerFollowingState() {
  return <Live snapshot={presentingSnapshot({ presenter: "nora", page: 3 })} />;
}

export function ViewerBrowsingState() {
  return <Live snapshot={presentingSnapshot({ presenter: "nora", page: 3 })} />;
}

export function PresenterZoomedState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", page: 3, zoom: 175 })} />;
}

export function PreparingState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", status: "preparing" })} />;
}

export function BesideScreenShareState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", page: 5, screenShare: true })} />;
}
