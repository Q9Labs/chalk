import annotationFont from "@q9labsai/chalk-screen-annotation/fonts/Figtree-SemiBold.ttf?url";
import type { SpaceClient } from "@q9labsai/chalk-client";
import type { ScreenAnnotationHelperShare, ScreenAnnotationSetup } from "@q9labsai/chalk-react";
import { classifyHelperCapture } from "./screen-annotation-helper-capture";

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
export function callAnnotation(options: { readonly apiBaseUrl: string; readonly tenantId?: string; readonly accountId?: string; readonly mediaProof: () => string | null | undefined; readonly client: Pick<SpaceClient, "getSnapshot"> }): ScreenAnnotationSetup {
  if (!installUrl || typeof window === "undefined") return webAnnotation;
  const { userAgent, maxTouchPoints } = window.navigator;
  // iPadOS Safari can identify itself as a Mac when requesting desktop sites.
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return webAnnotation;
  const captureTrack = (share: ScreenAnnotationHelperShare) => {
    const captured = options.client.getSnapshot().media.screenShare;
    return captured?.publicationId === share.layer.publication_id ? (captured.track ?? undefined) : undefined;
  };
  const captureGuidance = (share: ScreenAnnotationHelperShare) => {
    const { chromium, monitor, windowId } = classifyHelperCapture(share.surface, captureTrack(share), userAgent);
    if (!chromium) return "To see marks on your screen with Chalk Helper, share your entire screen from Chrome or Edge.";
    if (!monitor && !windowId) return "Chalk Helper can’t show marks on this share. Share your entire screen to use it.";
    return undefined;
  };
  const helper = { installUrl, captureGuidance };
  const downloadOnly = { ...webAnnotation, helper };
  if (!options.tenantId || !window.isSecureContext || window.location.protocol !== "https:") return downloadOnly;
  const api = new URL(options.apiBaseUrl, window.location.origin);
  if (api.protocol !== "https:" || api.username || api.password) return downloadOnly;
  const tenantId = options.tenantId;
  const origin = window.location.origin;
  const loadHelper = async () => {
    const { createManagedAnnotationHelper } = await import("./screen-annotation-helper");
    return createManagedAnnotationHelper({
      origin,
      apiBaseUrl: api.href,
      mediaProof: options.mediaProof,
      tenantId,
      accountId: options.accountId,
      installUrl,
      captureTrack,
    });
  };
  return {
    ...webAnnotation,
    helper: {
      ...helper,
      async challenge(...args) {
        return (await loadHelper()).challenge(...args);
      },
      // Device-code pairing uses the signed-in dashboard, not the public arrival.
      ...(options.accountId && {
        deviceAccount: tenantId,
        async lookupCode(code, share, signal) {
          return (await loadHelper()).lookupCode(code, share, signal);
        },
      }),
    },
  };
}
