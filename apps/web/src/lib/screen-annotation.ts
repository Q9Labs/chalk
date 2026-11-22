import annotationFont from "@q9labsai/chalk-screen-annotation/fonts/Figtree-SemiBold.ttf?url";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import type { ScreenAnnotationSetup } from "@q9labsai/chalk-react";

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
  offerPngDownload: true,
};

/** Wires only the Helper adapter; the rest of the annotation setup is unchanged. */
export function callAnnotation(options: { readonly apiBaseUrl: string; readonly tenantId?: string; readonly mediaProof: () => string | null | undefined; readonly screenShare: () => SpaceSnapshot["media"]["screenShare"] }): ScreenAnnotationSetup {
  if (!options.tenantId || !installUrl || typeof window === "undefined" || !window.isSecureContext || window.location.protocol !== "https:") return webAnnotation;
  const api = new URL(options.apiBaseUrl, window.location.origin);
  if (api.protocol !== "https:" || api.username || api.password) return webAnnotation;
  const tenantId = options.tenantId;
  const origin = window.location.origin;
  const loadHelper = async () => {
    const { createManagedAnnotationHelper } = await import("./screen-annotation-helper");
    return createManagedAnnotationHelper({
      origin,
      apiBaseUrl: api.href,
      mediaProof: options.mediaProof,
      tenantId,
      installUrl,
      captureTrack: (share) => {
        const captured = options.screenShare();
        return captured?.publicationId === share.layer.publication_id ? (captured.track ?? undefined) : undefined;
      },
    });
  };
  return {
    ...webAnnotation,
    helper: {
      installUrl,
      deviceAccount: tenantId,
      async challenge(...args) {
        return (await loadHelper()).challenge(...args);
      },
      async lookupCode(...args) {
        return (await loadHelper()).lookupCode(...args);
      },
    },
  };
}
