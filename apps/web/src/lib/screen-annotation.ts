import { encodeAnnotationPng } from "@q9labsai/chalk-screen-annotation";
import annotationFont from "@q9labsai/chalk-screen-annotation/fonts/Figtree-SemiBold.ttf?url";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import type { ScreenAnnotationSetup } from "@q9labsai/chalk-react";

import { createManagedAnnotationHelper } from "./screen-annotation-helper";

function helperInstaller(): string | undefined {
  const configured = import.meta.env.VITE_CHALK_HELPER_INSTALL_URL;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const installUrl = helperInstaller();

export const webAnnotation: ScreenAnnotationSetup = {
  fontUrl: annotationFont,

  actions: {
    downloadPng: async (frame) => {
      const document = frame.image.ownerDocument;
      const png = await encodeAnnotationPng(frame, document);
      const url = URL.createObjectURL(png);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "chalk-annotated-screen.png";
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
  },
};

/** Wires only the Helper adapter; the rest of the annotation setup is unchanged. */
export function callAnnotation(options: { readonly apiBaseUrl: string; readonly mediaProof: () => string | null | undefined; readonly screenShare: () => SpaceSnapshot["media"]["screenShare"] }): ScreenAnnotationSetup {
  if (!installUrl || typeof window === "undefined" || !window.isSecureContext || window.location.protocol !== "https:") return webAnnotation;
  const api = new URL(options.apiBaseUrl, window.location.origin);
  if (api.protocol !== "https:" || api.username || api.password) return webAnnotation;
  return {
    ...webAnnotation,
    helper: createManagedAnnotationHelper({
      origin: window.location.origin,
      apiBaseUrl: api.href,
      mediaProof: options.mediaProof,
      installUrl,
      captureTrack: (share) => {
        const captured = options.screenShare();
        return captured?.publicationId === share.layer.publication_id ? (captured.track ?? undefined) : undefined;
      },
    }),
  };
}
