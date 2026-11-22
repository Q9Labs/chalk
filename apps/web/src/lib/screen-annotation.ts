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
  actions: {
    downloadPng: async (frame) => {
      const { encodeAnnotationPng } = await import("@q9labsai/chalk-screen-annotation");
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
