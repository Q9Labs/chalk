import { createPaintKit, ellipsize, RECORDING, roundedPath, THEMES, type PaintKit, type PaintKitOptions, type Theme } from "./draw.js";
import { paintTile } from "./paint-tiles.js";
import type { Scene } from "./scene.js";

const MAX_REACTIONS = 4;

export type PainterOptions = PaintKitOptions;

export interface Painter {
  /** A transparent-where-video PNG of the scene's UI layer. */
  readonly paint: (scene: Scene) => Promise<Buffer>;
}

export function createPainter(options: PainterOptions): Painter {
  const kit = createPaintKit(options);
  return {
    async paint(scene) {
      const theme = THEMES[scene.colorScheme];
      const { context, width, height } = kit;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = theme.paper;
      context.fillRect(0, 0, width, height);
      await paintHeader(kit, scene, theme);
      for (const tile of scene.tiles) await paintTile(kit, tile, scene);
      paintReactions(kit, scene, theme);
      return await kit.canvas.encode("png");
    },
  };
}

async function paintHeader(kit: PaintKit, scene: Scene, theme: Theme): Promise<void> {
  const { context, px, font, width } = kit;
  const centerY = px(24);
  let textX = px(16);
  if (scene.logoAssetId !== undefined) {
    const logo = await kit.loadAsset(scene.logoAssetId);
    const size = px(24);
    roundedPath(context, { x: textX, y: centerY - size / 2, width: size, height: size }, px(6));
    context.save();
    context.clip();
    context.drawImage(logo, textX, centerY - size / 2, size, size);
    context.restore();
    textX += size + px(10);
  }
  context.fillStyle = theme.ink;
  context.font = font(600, 15);
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillText(ellipsize(context, scene.spaceName, width * 0.6), textX, centerY);

  context.font = font(600, 12);
  const label = "REC";
  const labelWidth = context.measureText(label).width;
  const labelX = width - px(16) - labelWidth;
  context.fillStyle = RECORDING;
  context.beginPath();
  context.arc(labelX - px(10), centerY, px(4), 0, Math.PI * 2);
  context.fill();
  context.fillStyle = theme.ink2;
  context.fillText(label, labelX, centerY);
}

function paintReactions(kit: PaintKit, scene: Scene, theme: Theme): void {
  const { context, px, font } = kit;
  const shown = scene.reactions.slice(-MAX_REACTIONS);
  let y = kit.height - px(16) - px(48);
  context.textBaseline = "middle";
  context.textAlign = "left";
  for (const reaction of shown.toReversed()) {
    context.font = font(500, 13);
    const name = ellipsize(context, reaction.displayName, px(160));
    const nameWidth = context.measureText(name).width;
    context.font = font(400, 20);
    const emojiWidth = context.measureText(reaction.value).width;
    const height = px(36);
    const width = px(12) + emojiWidth + px(8) + nameWidth + px(14);
    const x = px(28);
    context.fillStyle = theme.surface;
    roundedPath(context, { x, y: y - height, width, height }, px(18));
    context.fill();
    context.strokeStyle = theme.line;
    context.lineWidth = px(1);
    context.stroke();
    context.fillText(reaction.value, x + px(12), y - height / 2 + px(1));
    context.font = font(500, 13);
    context.fillStyle = theme.ink;
    context.fillText(name, x + px(12) + emojiWidth + px(8), y - height / 2);
    y -= height + px(8);
  }
}
