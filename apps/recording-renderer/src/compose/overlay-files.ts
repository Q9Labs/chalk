import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobalFonts, loadImage, type Image } from "@napi-rs/canvas";
import { ANNOTATION_FONT_FAMILY } from "@q9labsai/chalk-screen-annotation";
import { createFontRegistry } from "./fonts.js";
import { createPainter } from "./paint.js";
import { createWhiteboardRenderer } from "./whiteboard.js";
import type { ComposeOutput } from "./plan.js";
import type { SceneSpan } from "./scene.js";
import type { VerifiedRenderInputs } from "../node/inputs.js";

export async function paintOverlays(spans: readonly SceneSpan[], inputs: VerifiedRenderInputs, output: ComposeOutput, workDirectory: string, fontsDirectory: string): Promise<ReadonlyMap<string, string>> {
  if (inputs.annotation.length > 0 && GlobalFonts.registerFromPath(join(fontsDirectory, "Figtree-SemiBold.ttf"), ANNOTATION_FONT_FAMILY) === null) {
    throw new Error("recording annotation font could not be registered");
  }
  const fonts = await createFontRegistry(join(fontsDirectory, "excalidraw", "Liberation"));
  const fontFamilies = await fonts.registerSubsetFamily("Figtree", join(fontsDirectory, "Figtree"));
  const images = new Map<string, Promise<Image>>();
  const assetPath = (assetId: string): string => {
    const asset = inputs.assets.get(assetId);
    if (asset === undefined) throw new TypeError(`recording asset ${assetId} is not verified`);
    return asset.path;
  };
  const painter = createPainter({
    width: output.width,
    height: output.height,
    fontFamilies,
    loadAsset: (assetId) => {
      let image = images.get(assetId);
      if (image === undefined) {
        image = readFile(assetPath(assetId)).then((bytes) => loadImage(bytes));
        images.set(assetId, image);
      }
      return image;
    },
    renderWhiteboard: createWhiteboardRenderer({
      fonts,
      fontsDirectory: join(fontsDirectory, "excalidraw"),
      loadAsset: async (assetId) => ({ bytes: await readFile(assetPath(assetId)), contentType: inputs.assets.get(assetId)!.contentType }),
    }),
  });
  const overlays = new Map<string, string>();
  for (const span of spans) {
    if (overlays.has(span.sceneKey)) continue;
    const path = join(workDirectory, `overlay-${overlays.size}.png`);
    await writeFile(path, await painter.paint(span.scene), { mode: 0o600 });
    overlays.set(span.sceneKey, path);
  }
  return overlays;
}
