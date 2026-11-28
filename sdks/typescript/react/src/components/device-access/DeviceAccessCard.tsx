import { ChalkPopoverPrimitive as Popover, ChalkSheet } from "../chalk-ui";
import { useRef } from "react";
import { useNarrowCall } from "../../internal/call-width";
import { useMediaQuery } from "../../internal/useMediaQuery";
import { DeviceGlyph, Glyph, Illustration } from "./AccessSteps";
import { DeviceAccessStyles } from "./DeviceAccessStyles";
import { canRetryFromCard, cardCopy, systemSettingsLink } from "./card-copy";
import { type DeviceAccessReason, type DeviceKind } from "./model";

/** What a dock button needs to show its problem and open the card. */
export { resolveAccess } from "./resolve";

export interface DeviceAccessControl {
  readonly reason: DeviceAccessReason;
  /** The dock button's tooltip and label. */
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
  /** A retry from the card has run and the device is still refused. */
  readonly stillBlocked: boolean;
  /** Picks the browser's first listed device, for a remembered one that is gone. Absent when the browser lists none. */
  readonly onUseDefault?: () => void;
  /** The label of that first device, shown in the unavailable card. */
  readonly defaultDeviceLabel?: string;
}

function CardActions({ control, link, retry, onChooseAnother }: { readonly control: DeviceAccessControl; readonly link: string | null; readonly retry: boolean; readonly onChooseAnother?: () => void }) {
  const { reason } = control;
  if (!link && !retry && reason.kind !== "unavailable") return null;
  const choosable = (reason.kind === "busy" || reason.kind === "unavailable") && onChooseAnother;
  return (
    <div className="chalk-access-actions">
      {link ? (
        <a className="chalk-access-primary" href={link}>
          {reason.kind === "blocked-system" && reason.platform === "windows" ? "Open Settings" : "Open System Settings"}
        </a>
      ) : null}
      {choosable ? (
        <button type="button" className="chalk-access-secondary" onClick={onChooseAnother}>
          Choose another
        </button>
      ) : null}
      {reason.kind === "unavailable" && control.onUseDefault ? (
        <button type="button" className="chalk-access-primary" onClick={control.onUseDefault}>
          Use default
        </button>
      ) : null}
      {retry ? (
        <button type="button" className={link ? "chalk-access-secondary" : "chalk-access-primary"} onClick={control.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function CardBody({ device, control, onChooseAnother }: { readonly device: DeviceKind; readonly control: DeviceAccessControl; readonly onChooseAnother?: () => void }) {
  const { reason } = control;
  const copy = cardCopy(device, reason);
  const link = reason.kind === "blocked-system" && reason.platform !== "android" ? systemSettingsLink(device, reason.platform) : null;
  const retry = canRetryFromCard(device, reason);
  return (
    <>
      <div className="chalk-access-head">
        <span className="chalk-access-glyph" data-danger={copy.danger || undefined}>
          <DeviceGlyph device={device} off />
        </span>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.detail}</p>
        </div>
        <button type="button" className="chalk-access-close" aria-label="Close" onClick={() => control.onOpenChange(false)}>
          <Glyph name="close" />
        </button>
      </div>
      <Illustration device={device} reason={reason} defaultDeviceLabel={control.defaultDeviceLabel} />
      {control.stillBlocked && retry ? (
        <div className="chalk-access-note" data-bad role="status">
          {device === "screen" ? "Still not sharing." : "Still blocked."} Chalk will not try again on its own.
        </div>
      ) : null}
      <CardActions control={control} link={link} retry={retry} onChooseAnother={onChooseAnother} />
      {copy.note ? <div className="chalk-access-note">{copy.note}</div> : null}
    </>
  );
}

/** The dock button's "!" badge and its card, which live together so both load on the first refusal. */
export function DeviceAccessCard(props: { readonly device: DeviceKind; readonly anchor: HTMLElement | null; readonly control: DeviceAccessControl }) {
  return (
    <>
      <DeviceAccessStyles />
      <span className="chalk-access-badge" aria-hidden="true">
        !
      </span>
      <DeviceAccessSurface {...props} />
    </>
  );
}

/** One card for every way a microphone, camera or screen share can be refused. Popover above the dock button, bottom sheet on phones. */
function DeviceAccessSurface({ device, anchor, control }: { readonly device: DeviceKind; readonly anchor: HTMLElement | null; readonly control: DeviceAccessControl }) {
  const narrowWindow = useMediaQuery("(max-width: 640px)");
  const phone = useNarrowCall() || narrowWindow;
  const popup = useRef<HTMLDivElement>(null);
  const label = cardCopy(device, control.reason).title;
  // "Choose another" closes the card and opens the device menu beside the button. The phone dock has no microphone menu.
  const onChooseAnother =
    device === "microphone" && phone
      ? undefined
      : () => {
          control.onOpenChange(false);
          anchor?.querySelector<HTMLButtonElement>(".chalk-shell-caret")?.click();
        };
  const body = <CardBody device={device} control={control} onChooseAnother={onChooseAnother} />;
  if (phone)
    return (
      <>
        <DeviceAccessStyles />
        <ChalkSheet open={control.open} onOpenChange={control.onOpenChange} title={label}>
          <div className="chalk-access-sheet-body">{body}</div>
        </ChalkSheet>
      </>
    );
  const root = anchor?.closest<HTMLElement>("[data-chalk]") ?? undefined;
  return (
    <Popover.Root
      open={control.open}
      onOpenChange={(open, details) => {
        // The dock button toggles the card itself; closing here as well would reopen it on the click.
        if (!open && details.reason === "outside-press" && details.event.target instanceof Node && anchor?.contains(details.event.target)) return;
        control.onOpenChange(open);
      }}
    >
      <DeviceAccessStyles />
      <Popover.Portal container={root}>
        <Popover.Positioner anchor={anchor} side="top" align="center" sideOffset={14} collisionPadding={8} collisionBoundary={root} className="chalk-access-positioner">
          <Popover.Popup ref={popup} initialFocus={popup} tabIndex={-1} aria-label={label} data-part="device-access-card" className="chalk-access-card">
            <Popover.Arrow className="chalk-access-arrow" />
            {body}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
