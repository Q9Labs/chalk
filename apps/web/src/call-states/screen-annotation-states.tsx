import { ScreenAnnotationFixture } from "./screen-annotation";
import type { CallState } from "./states";

const draw = [{ click: "Draw" }, { wait: 400 }];

/** Watching and drawing on a screen share, and the sharer's bar above their own preview. */
export const SCREEN_ANNOTATION_STATES: readonly CallState[] = [
  { id: "share-viewer-draw", title: "Share: viewer can draw", render: () => <ScreenAnnotationFixture marks /> },
  { id: "share-viewer-drawing", title: "Share: viewer drawing", actions: draw, render: () => <ScreenAnnotationFixture marks /> },
  { id: "share-viewer-drawing-more", title: "Share: viewer drawing, More menu", actions: [...draw, { click: "More" }, { wait: 300 }], render: () => <ScreenAnnotationFixture marks /> },
  { id: "share-viewer-drawing-colour", title: "Share: viewer drawing, colour swatches", actions: [...draw, { click: "Colour" }, { wait: 300 }], render: () => <ScreenAnnotationFixture marks /> },
  { id: "share-viewer-ask", title: "Share: viewer asks to draw", render: () => <ScreenAnnotationFixture policy="picked" /> },
  { id: "share-viewer-asked", title: "Share: viewer asked and waits", render: () => <ScreenAnnotationFixture policy="picked" asked /> },
  { id: "share-viewer-hosts-only", title: "Share: only hosts can draw", render: () => <ScreenAnnotationFixture policy="hosts" /> },
  { id: "share-sharer", title: "Share: sharer bar", render: () => <ScreenAnnotationFixture view="host" /> },
  { id: "share-sharer-drawing", title: "Share: sharer sees someone drawing", render: () => <ScreenAnnotationFixture view="host" marks /> },
  { id: "share-sharer-request", title: "Share: sharer allows a request", render: () => <ScreenAnnotationFixture view="host" policy="picked" asked /> },
  { id: "share-sharer-who", title: "Share: who can draw menu", actions: [{ click: "Who can draw: Everyone" }, { wait: 300 }], render: () => <ScreenAnnotationFixture view="host" marks /> },
  { id: "helper-offer", title: "Chalk Helper offer", render: () => <ScreenAnnotationFixture helper="offer" marks /> },
  { id: "helper-fingerprint", title: "Chalk Helper fingerprint", actions: [{ click: "I have it" }, { wait: 300 }], render: () => <ScreenAnnotationFixture helper="fingerprint" marks /> },
  { id: "helper-confirm", title: "Chalk Helper confirmation code", actions: [{ click: "I have it" }, { wait: 300 }, { click: "It matches" }, { wait: 300 }], render: () => <ScreenAnnotationFixture helper="confirm" marks /> },
  { id: "helper-connected", title: "Chalk Helper connected", actions: [{ click: "I have it" }, { wait: 300 }, { click: "It matches" }, { wait: 500 }], render: () => <ScreenAnnotationFixture helper="connected" marks /> },
  { id: "share-sharer-helper", title: "Share: show marks on my screen", actions: [{ click: "Show on my screen" }, { wait: 300 }], render: () => <ScreenAnnotationFixture view="host" marks captureSurface="monitor" /> },
];
