import annotationFont from "@q9labsai/chalk-screen-annotation/fonts/Figtree-SemiBold.ttf?url";
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
  helper: installUrl ? { installUrl } : undefined,
  offerPngDownload: true,
};
