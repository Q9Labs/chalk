import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";

export function createPreviewPresenting(): SpaceClient["presenting"] {
  return {
    present: async () => ({ kind: "unavailable" }),
    setPage: async () => ({ kind: "unavailable" }),
    setZoom: async () => ({ kind: "unavailable" }),
    stop: async () => ({ kind: "unavailable" }),
    manifest: async () => {
      throw new TypeError("preview presenting is unavailable");
    },
    zoomUrl: async () => {
      throw new TypeError("preview presenting is unavailable");
    },
  };
}

export function createPreviewPresentingSnapshot(): SpaceSnapshot["presenting"] {
  return { status: "connecting", available: true, revision: 0, documents: [], manifests: {} };
}
