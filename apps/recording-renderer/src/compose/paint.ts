import { ComputerScreenShareIcon, MicOff01Icon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { createCanvas, Path2D, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Rect, Scene, SceneParticipant, SceneTile } from "./scene.js";

/** The painter's colors, from design.md: Chalk Light and its dark counterpart. */
interface Theme {
  readonly paper: string;
  readonly surface: string;
  readonly ink: string;
  readonly ink2: string;
  readonly line: string;
  readonly washes: readonly string[];
}

const THEMES: Readonly<Record<Scene["colorScheme"], Theme>> = {
  light: { paper: "#F7F6F2", surface: "#FFFFFF", ink: "#0C0E12", ink2: "#555B65", line: "#DEDDD7", washes: ["#EDF6EB", "#FFF8E5", "#EAF7FB", "#FDF0F0"] },
  dark: { paper: "#0C0E12", surface: "#16191F", ink: "#F2F1ED", ink2: "#A3A8B0", line: "#2A2E35", washes: ["#1B2419", "#262214", "#16232A", "#2A1B1B"] },
};

const IDENTITY_COLORS = ["#315F72", "#5C6650", "#6B5B4F", "#64576B", "#49645D", "#665D42", "#4D5D73", "#6D5158"] as const;
const SPEAKING = "#80B879";
const HAND = "#D9B641";
const RECORDING = "#D67B7B";
const DANGER = "#E28C8C";
const NAME_TAG = "rgba(12, 14, 18, 0.80)";
const TILE_RADIUS = 10;
const TAG_RADIUS = 5;
const MAX_REACTIONS = 4;

type IconNode = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

export interface PainterOptions {
  readonly width: number;
  readonly height: number;
  /** CSS family list for interface text, from registerSubsetFamily. */
  readonly fontFamilies: string;
  readonly loadAsset: (assetId: string) => Promise<Image>;
  readonly renderWhiteboard: (stateAssetId: string, colorScheme: Scene["colorScheme"], rect: Rect) => Promise<Canvas>;
}

export interface Painter {
  /** A transparent-where-video PNG of the scene's UI layer. */
  readonly paint: (scene: Scene) => Promise<Buffer>;
}

export function createPainter(options: PainterOptions): Painter {
  const scale = options.width / 1280;
  const canvas = createCanvas(options.width, options.height);
  const context = canvas.getContext("2d");
  const font = (weight: number, size: number): string => `${weight} ${Math.round(size * scale)}px ${options.fontFamilies}`;
  const px = (value: number): number => value * scale;

  async function paint(scene: Scene): Promise<Buffer> {
    const theme = THEMES[scene.colorScheme];
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, options.width, options.height);
    context.fillStyle = theme.paper;
    context.fillRect(0, 0, options.width, options.height);
    await paintHeader(scene, theme);
    for (const tile of scene.tiles) await paintTile(tile, scene, theme);
    paintReactions(scene, theme);
    return await canvas.encode("png");
  }

  async function paintHeader(scene: Scene, theme: Theme): Promise<void> {
    const centerY = px(24);
    let textX = px(16);
    if (scene.logoAssetId !== undefined) {
      const logo = await options.loadAsset(scene.logoAssetId);
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
    context.fillText(ellipsize(context, scene.spaceName, options.width * 0.6), textX, centerY);

    context.font = font(600, 12);
    const label = "REC";
    const labelWidth = context.measureText(label).width;
    const labelX = options.width - px(16) - labelWidth;
    context.fillStyle = RECORDING;
    context.beginPath();
    context.arc(labelX - px(10), centerY, px(4), 0, Math.PI * 2);
    context.fill();
    context.fillStyle = theme.ink2;
    context.fillText(label, labelX, centerY);
  }

  async function paintTile(tile: SceneTile, scene: Scene, theme: Theme): Promise<void> {
    if (tile.kind === "whiteboard") {
      await paintWhiteboardTile(tile, scene, theme);
      return;
    }
    await paintPersonTile(tile, theme);
  }

  async function paintWhiteboardTile(tile: Extract<SceneTile, { kind: "whiteboard" }>, scene: Scene, theme: Theme): Promise<void> {
    const board = await options.renderWhiteboard(tile.stateAssetId, scene.colorScheme, tile.rect);
    context.save();
    roundedPath(context, tile.rect, px(TILE_RADIUS));
    context.clip();
    context.fillStyle = scene.colorScheme === "dark" ? "#121212" : "#FFFFFF";
    context.fillRect(tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height);
    drawContained(context, board, inset(tile.rect, px(12)));
    context.restore();
    strokeTile(tile.rect, theme.line, px(1));
  }

  async function paintPersonTile(tile: Exclude<SceneTile, { kind: "whiteboard" }>, theme: Theme): Promise<void> {
    const radius = px(TILE_RADIUS);
    if (tile.video !== undefined) {
      // The compositor places video underneath; the rounded clear keeps its corners.
      context.save();
      roundedPath(context, tile.rect, radius);
      context.clip();
      context.clearRect(tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height);
      context.restore();
    } else if (tile.kind === "screen_share") {
      paintUnavailableScreen(tile, theme);
    } else {
      context.fillStyle = theme.washes[hash(tile.participant.id) % theme.washes.length]!;
      roundedPath(context, tile.rect, radius);
      context.fill();
      await paintAvatar(tile.participant, tile.rect);
    }

    paintPersonTileDetails(tile);
  }

  // Matches the live ScreenShareView empty state, for gaps in the shared screen.
  function paintUnavailableScreen(tile: Extract<SceneTile, { kind: "screen_share" }>, theme: Theme): void {
    const { rect } = tile;
    context.fillStyle = theme.surface;
    roundedPath(context, rect, px(TILE_RADIUS));
    context.fill();
    strokeTile(rect, theme.line, px(1));
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const iconSize = px(20);
    drawIcon(ComputerScreenShareIcon, centerX - iconSize / 2, centerY - px(40), iconSize, theme.ink2);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = font(600, 14);
    context.fillStyle = theme.ink;
    context.fillText(ellipsize(context, "Screen share unavailable", rect.width - px(32)), centerX, centerY);
    context.font = font(400, 13);
    context.fillStyle = theme.ink2;
    context.fillText(ellipsize(context, `${tile.participant.displayName}’s screen isn’t available at this moment.`, rect.width - px(32)), centerX, centerY + px(22));
  }

  function paintPersonTileDetails(tile: Exclude<SceneTile, { kind: "whiteboard" }>): void {
    paintPersonNameTag(tile);
    if (tile.kind === "participant" && tile.participant.handRaised) paintHand(tile.rect);
    if (tile.kind === "participant" && tile.participant.speaking) strokeTile(tile.rect, SPEAKING, px(2.5));
  }

  function paintPersonNameTag(tile: Exclude<SceneTile, { kind: "whiteboard" }>): void {
    const tag = tile.kind === "screen_share" ? `${tile.participant.displayName}’s screen` : tile.participant.displayName;
    paintNameTag(tile.rect, tag, tile.kind === "screen_share" ? ComputerScreenShareIcon : tile.participant.microphoneMuted ? MicOff01Icon : undefined, tile.kind === "participant" && tile.participant.microphoneMuted ? DANGER : "#FFFFFF");
  }

  async function paintAvatar(participant: SceneParticipant, rect: Rect): Promise<void> {
    const diameter = Math.max(px(28), Math.min(px(120), Math.min(rect.width, rect.height) * 0.38));
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
    if (participant.avatarAssetId !== undefined) {
      const avatar = await options.loadAsset(participant.avatarAssetId);
      context.clip();
      drawCovered(context, avatar, { x: centerX - diameter / 2, y: centerY - diameter / 2, width: diameter, height: diameter });
    } else {
      context.fillStyle = IDENTITY_COLORS[hash(participant.id) % IDENTITY_COLORS.length]!;
      context.fill();
      context.fillStyle = "#FFFFFF";
      context.font = font(600, (diameter / scale) * 0.38);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(initials(participant.displayName), centerX, centerY + diameter * 0.02);
    }
    context.restore();
  }

  function paintNameTag(rect: Rect, text: string, icon: IconNode | undefined, iconColor: string): void {
    const height = px(24);
    const padding = px(8);
    const iconSize = icon === undefined ? 0 : px(14);
    const iconGap = icon === undefined ? 0 : px(6);
    context.font = font(500, 12.5);
    const maxTextWidth = Math.max(px(40), rect.width - px(16) - padding * 2 - iconSize - iconGap);
    const label = ellipsize(context, text, maxTextWidth);
    const width = padding * 2 + iconSize + iconGap + context.measureText(label).width;
    const x = rect.x + px(8);
    const y = rect.y + rect.height - px(8) - height;
    context.fillStyle = NAME_TAG;
    roundedPath(context, { x, y, width, height }, px(TAG_RADIUS));
    context.fill();
    if (icon !== undefined) drawIcon(icon, x + padding, y + (height - iconSize) / 2, iconSize, iconColor);
    context.fillStyle = "#FFFFFF";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(label, x + padding + iconSize + iconGap, y + height / 2 + px(0.5));
  }

  function paintHand(rect: Rect): void {
    const size = px(26);
    const x = rect.x + px(8);
    const y = rect.y + px(8);
    context.fillStyle = HAND;
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    context.fill();
    drawIcon(WavingHand01Icon, x + px(5), y + px(5), size - px(10), "#0C0E12");
  }

  function paintReactions(scene: Scene, theme: Theme): void {
    const shown = scene.reactions.slice(-MAX_REACTIONS);
    let y = options.height - px(16) - px(48);
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

  function strokeTile(rect: Rect, color: string, width: number): void {
    context.strokeStyle = color;
    context.lineWidth = width;
    roundedPath(context, inset(rect, width / 2), px(TILE_RADIUS) - width / 2);
    context.stroke();
  }

  function drawIcon(icon: IconNode, x: number, y: number, size: number, color: string): void {
    context.save();
    context.translate(x, y);
    context.scale(size / 24, size / 24);
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const [tag, attributes] of icon) {
      const d = attributes.d;
      if (tag !== "path" || typeof d !== "string") continue;
      const path = new Path2D(d);
      if (attributes.fill === "currentColor") context.fill(path);
      if (attributes.stroke === "currentColor") {
        context.lineWidth = Number(attributes.strokeWidth ?? 1.5) * 1.2;
        context.stroke(path);
      }
    }
    context.restore();
  }

  return { paint };
}

function roundedPath(context: SKRSContext2D, rect: Rect, radius: number): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2)));
}

function inset(rect: Rect, amount: number): Rect {
  return { x: rect.x + amount, y: rect.y + amount, width: Math.max(0, rect.width - amount * 2), height: Math.max(0, rect.height - amount * 2) };
}

function drawContained(context: SKRSContext2D, image: Image | Canvas, rect: Rect): void {
  const ratio = Math.min(rect.width / image.width, rect.height / image.height);
  const width = image.width * ratio;
  const height = image.height * ratio;
  context.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

function drawCovered(context: SKRSContext2D, image: Image, rect: Rect): void {
  const ratio = Math.max(rect.width / image.width, rect.height / image.height);
  const width = image.width * ratio;
  const height = image.height * ratio;
  context.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

function ellipsize(context: SKRSContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const characters = [...text];
  while (characters.length > 1 && context.measureText(`${characters.join("")}…`).width > maxWidth) characters.pop();
  return `${characters.join("")}…`;
}

export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!].map((word) => [...word][0]) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (Math.imul(result, 31) + character.codePointAt(0)!) >>> 0;
  return result;
}
