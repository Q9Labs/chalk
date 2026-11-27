import type { ParticipantDevice } from "@q9labsai/chalk-client";
import { ChalkTooltip } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";

/** The device that earns a tile badge: a phone, tablet or foldable that isn't yours, on a tile that shows status. A computer never gets one. */
export function badgeDevice(participant: { readonly device?: ParticipantDevice; readonly isLocal?: boolean }, showStatus: boolean): BadgeDevice | undefined {
  const device = participant.device;
  if (!showStatus || participant.isLocal || !device || device.form === "computer") return undefined;
  return device as BadgeDevice;
}

type BadgeDevice = ParticipantDevice & { readonly form: Exclude<ParticipantDevice["form"], "computer"> };

/** The bottom-right icon on a tile. Hover or keyboard focus says where the person joined from. */
export function TileDevice({ device }: { readonly device: BadgeDevice }) {
  const joined = `Joined from ${device.joinedFrom}`;
  return (
    <ChalkTooltip
      trigger={
        <span role="img" tabIndex={0} data-part="tile-device-badge" aria-label={joined} className="chalk-tile-device">
          <style href="chalk-tile-device" precedence="default">
            {TILE_DEVICE_CSS}
          </style>
          <StageIcon name={device.form} size={14} className="shrink-0" />
        </span>
      }
    >
      {joined}
    </ChalkTooltip>
  );
}

const TILE_DEVICE_CSS = `.chalk-tile-device {position:absolute;right:var(--space-2);bottom:var(--space-2);z-index:30;display:inline-flex;align-items:center;height:24px;padding:0 var(--space-2);border-radius:var(--corner-md);background:var(--chalk-overlay);color:var(--chalk-on-overlay);}
.chalk-tile-device ~ [data-part="tile-tag"] {max-width:calc(100% - var(--space-2) * 3 - 28px);}
@container (max-height: 119.98px) {
  .chalk-tile-device {display:none;}
  .chalk-tile-device ~ [data-part="tile-tag"] {max-width:calc(100% - var(--space-2) * 2);}
}
`;
