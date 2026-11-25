import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { Live } from "./live";
import { liveSnapshot, PEOPLE, type Person } from "./fixtures";

const nora: Person = PEOPLE[0]!;

/** A letterboxed SVG page so the fixture Document viewer has real page pixels without a renderer. */
function pageImage(page: number, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100" viewBox="0 0 850 1100"><rect width="850" height="1100" fill="#ffffff"/><rect x="80" y="90" width="420" height="34" rx="6" fill="${accent}"/><rect x="80" y="170" width="690" height="14" rx="7" fill="#d7dce3"/><rect x="80" y="200" width="640" height="14" rx="7" fill="#e2e6ec"/><rect x="80" y="230" width="690" height="14" rx="7" fill="#d7dce3"/><rect x="80" y="300" width="300" height="180" rx="10" fill="${accent}" opacity="0.24"/><rect x="420" y="300" width="350" height="180" rx="10" fill="#eef1f5"/><rect x="80" y="530" width="690" height="12" rx="6" fill="#e2e6ec"/><rect x="80" y="556" width="620" height="12" rx="6" fill="#e2e6ec"/><rect x="80" y="582" width="670" height="12" rx="6" fill="#e2e6ec"/><text x="80" y="1020" font-family="sans-serif" font-size="28" fill="#98a1ad">${page}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function pages(count: number, accent: string) {
  return Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    width: 850,
    height: 1100,
    status: "ready" as const,
    imageUrl: pageImage(index + 1, accent),
    thumbnailUrl: pageImage(index + 1, accent),
  }));
}

type PresentingFixtureOptions = {
  readonly presenter: "self" | "nora";
  readonly page?: number;
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
      revision: 3,
      documents: [{ documentId, presenterId, page: options.page ?? 3, zoom: 100, startedAtMs: Date.now() - 60_000 }],
      manifests: {
        [documentId]: {
          documentId,
          attachmentId: "attachment-1",
          fileName: "product-plan.pdf",
          status,
          pageCount: status === "ready" ? pageCount : undefined,
          pages: status === "ready" ? pages(pageCount, "#4f6bd8") : [],
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

export function PreparingState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", status: "preparing" })} />;
}

export function BesideScreenShareState() {
  return <Live snapshot={presentingSnapshot({ presenter: "self", page: 5, screenShare: true })} />;
}
