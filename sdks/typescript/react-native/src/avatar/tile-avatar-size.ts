/** A camera-off tile's avatar is 42 % of the tile's shorter side, between 32 and 150 pt. */
export function tileAvatarSize(width: number, height: number): number {
  return Math.round(Math.min(150, Math.max(32, Math.min(width, height) * 0.42)));
}
