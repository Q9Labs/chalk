import { ComputerScreenShareIcon, MicOff01Icon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { DANGER, drawContained, drawCovered, drawIcon, ellipsize, hash, HAND, IDENTITY_COLORS, initials, inset, NAME_TAG, roundedPath, SPEAKING, strokeTile, TAG_RADIUS, THEMES, TILE_RADIUS, type IconNode, type PaintKit, type Theme } from "./draw.js";
import type { Rect, Scene, SceneParticipant, SceneTile } from "./scene.js";

type WhiteboardTile = Extract<SceneTile, { kind: "whiteboard" }>;
type PersonTile = Exclude<SceneTile, { kind: "whiteboard" }>;

export async function paintTile(kit: PaintKit, tile: SceneTile, scene: Scene): Promise<void> {
  const theme = THEMES[scene.colorScheme];
  if (tile.kind === "whiteboard") await paintWhiteboardTile(kit, tile, scene, theme);
  else await paintPersonTile(kit, tile, theme);
}

async function paintWhiteboardTile(kit: PaintKit, tile: WhiteboardTile, scene: Scene, theme: Theme): Promise<void> {
  const { context, px } = kit;
  const board = await kit.renderWhiteboard(tile.stateAssetId, scene.colorScheme, tile.rect, tile.revision);
  context.save();
  roundedPath(context, tile.rect, px(TILE_RADIUS));
  context.clip();
  context.fillStyle = scene.colorScheme === "dark" ? "#121212" : "#FFFFFF";
  context.fillRect(tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height);
  drawContained(context, board, inset(tile.rect, px(12)));
  context.restore();
  strokeTile(kit, tile.rect, theme.line, px(1));
}

async function paintPersonTile(kit: PaintKit, tile: PersonTile, theme: Theme): Promise<void> {
  const { context, px } = kit;
  const radius = px(TILE_RADIUS);
  if (tile.video !== undefined) {
    // The compositor places video underneath; the rounded clear keeps its corners.
    context.save();
    roundedPath(context, tile.rect, radius);
    context.clip();
    context.clearRect(tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height);
    context.restore();
  } else if (tile.kind === "screen_share") {
    paintUnavailableScreen(kit, tile, theme);
  } else {
    context.fillStyle = theme.washes[hash(tile.participant.id) % theme.washes.length]!;
    roundedPath(context, tile.rect, radius);
    context.fill();
    await paintAvatar(kit, tile.participant, tile.rect);
  }
  paintPersonTileDetails(kit, tile);
}

// Matches the live ScreenShareView empty state, for gaps in the shared screen.
function paintUnavailableScreen(kit: PaintKit, tile: Extract<SceneTile, { kind: "screen_share" }>, theme: Theme): void {
  const { context, px, font } = kit;
  const { rect } = tile;
  context.fillStyle = theme.surface;
  roundedPath(context, rect, px(TILE_RADIUS));
  context.fill();
  strokeTile(kit, rect, theme.line, px(1));
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const iconSize = px(20);
  drawIcon(kit, ComputerScreenShareIcon, centerX - iconSize / 2, centerY - px(40), iconSize, theme.ink2);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = font(600, 14);
  context.fillStyle = theme.ink;
  context.fillText(ellipsize(context, "Screen share unavailable", rect.width - px(32)), centerX, centerY);
  context.font = font(400, 13);
  context.fillStyle = theme.ink2;
  context.fillText(ellipsize(context, `${tile.participant.displayName}’s screen isn’t available at this moment.`, rect.width - px(32)), centerX, centerY + px(22));
}

function paintPersonTileDetails(kit: PaintKit, tile: PersonTile): void {
  if (tile.kind === "screen_share") {
    paintNameTag(kit, tile.rect, `${tile.participant.displayName}’s screen`, ComputerScreenShareIcon, "#FFFFFF");
    return;
  }
  const { participant } = tile;
  const muted = participant.microphoneMuted;
  paintNameTag(kit, tile.rect, participant.displayName, muted ? MicOff01Icon : undefined, muted ? DANGER : "#FFFFFF");
  if (participant.handRaised) paintHand(kit, tile.rect);
  if (participant.speaking) strokeTile(kit, tile.rect, SPEAKING, kit.px(2.5));
}

async function paintAvatar(kit: PaintKit, participant: SceneParticipant, rect: Rect): Promise<void> {
  const { context, px, font } = kit;
  const diameter = Math.max(px(28), Math.min(px(120), Math.min(rect.width, rect.height) * 0.38));
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  context.save();
  context.beginPath();
  context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
  if (participant.avatarAssetId !== undefined) {
    const avatar = await kit.loadAsset(participant.avatarAssetId);
    context.clip();
    drawCovered(context, avatar, { x: centerX - diameter / 2, y: centerY - diameter / 2, width: diameter, height: diameter });
  } else {
    context.fillStyle = IDENTITY_COLORS[hash(participant.id) % IDENTITY_COLORS.length]!;
    context.fill();
    context.fillStyle = "#FFFFFF";
    context.font = font(600, (diameter / px(1)) * 0.38);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(initials(participant.displayName), centerX, centerY + diameter * 0.02);
  }
  context.restore();
}

function paintNameTag(kit: PaintKit, rect: Rect, text: string, icon: IconNode | undefined, iconColor: string): void {
  const { context, px, font } = kit;
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
  if (icon !== undefined) drawIcon(kit, icon, x + padding, y + (height - iconSize) / 2, iconSize, iconColor);
  context.fillStyle = "#FFFFFF";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, x + padding + iconSize + iconGap, y + height / 2 + px(0.5));
}

function paintHand(kit: PaintKit, rect: Rect): void {
  const { context, px } = kit;
  const size = px(26);
  const x = rect.x + px(8);
  const y = rect.y + px(8);
  context.fillStyle = HAND;
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  context.fill();
  drawIcon(kit, WavingHand01Icon, x + px(5), y + px(5), size - px(10), "#0C0E12");
}
