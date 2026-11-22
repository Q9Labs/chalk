import { encodeAnnotationPng } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationFrame } from "./model";

export async function downloadAnnotationPng(frame: ScreenAnnotationFrame): Promise<void> {
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
}
