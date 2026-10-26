import { encode } from "uqr";
import { LIGHT_CHALK_THEME_TOKENS } from "../../theme";

export function inviteQr(value: string) {
  // Keep the existing long-link fallback rather than growing beyond the share panel.
  if (new TextEncoder().encode(value).length > 858) return null;
  const { data, size } = encode(value, { ecc: "M", border: 4 });
  const pixels = size * Math.max(2, Math.round(112 / size));
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
  return { path, size, pixels };
}

export function InviteQR({ code }: { readonly code: NonNullable<ReturnType<typeof inviteQr>> }) {
  return (
    <svg data-part="share-qr" role="img" aria-label="Scan to join this call" width={code.pixels} height={code.pixels} viewBox={`0 0 ${code.size} ${code.size}`} style={{ width: code.pixels, height: code.pixels }} className="shrink-0" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill={LIGHT_CHALK_THEME_TOKENS.surface} />
      <path fill={LIGHT_CHALK_THEME_TOKENS.textStrong} d={code.path} />
    </svg>
  );
}
