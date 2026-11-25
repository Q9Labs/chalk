import type { ParticipantDevice } from "@q9labsai/chalk-client";
import { StageIcon } from "../stage/StageIcon";

/** The bottom-right tag on a phone, tablet or foldable tile, styled like the name tag. A computer never gets one. */
export function TileDevice({ name, device }: { readonly name: string; readonly device: ParticipantDevice }) {
  if (device.form === "computer") return null;
  return (
    <span role="img" data-part="tile-device-badge" aria-label={`${name}: on ${device.label}`} title={device.label} className="chalk-tile-device">
      <style href="chalk-tile-device" precedence="default">
        {TILE_DEVICE_CSS}
      </style>
      <StageIcon name={device.form} size={14} className="shrink-0" />
      <span className="chalk-tile-device-label">{device.label}</span>
    </span>
  );
}

// A narrow tile shows the icon alone, and the name tag gives up room to the badge in both sizes.
const TILE_DEVICE_CSS = `.chalk-tile-device {position:absolute;right:var(--space-2);bottom:var(--space-2);z-index:30;display:inline-flex;align-items:center;gap:var(--space-1-5);height:24px;padding:0 var(--space-2);border-radius:var(--corner-md);background:var(--chalk-overlay);color:var(--chalk-on-overlay);font-size:var(--type-caption);font-weight:500;line-height:1.4;white-space:nowrap;pointer-events:none;}
.chalk-tile-device-label {display:none;}
.chalk-tile-device ~ [data-part="tile-tag"] {max-width:calc(100% - var(--space-2) * 3 - 28px);}
@container (min-width: 280px) {
  .chalk-tile-device-label {display:inline;}
  .chalk-tile-device ~ [data-part="tile-tag"] {max-width:calc(100% - var(--space-2) * 3 - 132px);}
}
@container (max-height: 119.98px) {
  .chalk-tile-device {display:none;}
  .chalk-tile-device ~ [data-part="tile-tag"] {max-width:calc(100% - var(--space-2) * 2);}
}
`;
