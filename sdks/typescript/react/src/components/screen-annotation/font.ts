import { ANNOTATION_FONT_FAMILY } from "@q9labsai/chalk-screen-annotation";

const fonts = new WeakMap<Document, Promise<void>>();

export function loadAnnotationFont(document: Document, url?: string): Promise<void> {
  if (!url) return Promise.resolve();
  const existing = fonts.get(document);
  if (existing) return existing;
  const font = new FontFace(ANNOTATION_FONT_FAMILY, `url(${JSON.stringify(url)})`, { weight: "600" });
  const loading = font.load().then((loaded) => {
    document.fonts.add(loaded);
  });
  fonts.set(document, loading);
  return loading;
}
