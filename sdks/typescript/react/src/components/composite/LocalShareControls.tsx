import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import { usePhoneCall } from "../../internal/call-width";
import { ChalkButton, ChalkMenu, ChalkMenuItem } from "../chalk-ui";

/**
 * The header above your own shared screen. It sits in the tile's flow, so it never covers the preview.
 * The sharer's title line and the drawing buttons are portalled in through the two hosts.
 */
export function LocalShareControls({
  capture,
  pending,
  onChangeShare,
  onStopSharing,
  titleHost,
  policyHost,
}: {
  readonly capture?: ScreenShareCapture;
  readonly pending: boolean;
  readonly onChangeShare?: (options: ScreenShareOptions) => void;
  readonly onStopSharing?: () => void;
  readonly titleHost?: (element: HTMLElement | null) => void;
  readonly policyHost?: (element: HTMLElement | null) => void;
}) {
  const phone = usePhoneCall();
  const source = capture?.surface === "window" ? "a window" : capture?.surface === "browser" ? "a tab" : capture?.surface === "monitor" ? "your screen" : null;
  return (
    <div className="shrink-0">
      <div data-part="share-local-overlay" role="group" aria-label="Your share" className="group/hd relative z-30 flex h-12 items-center gap-1.5 border-b border-[var(--chalk-line)] pr-2 pl-3.5 text-(length:--type-caption) text-[var(--chalk-text)]">
        <div className="flex min-w-0 flex-1 items-center gap-2 group-has-[[data-part=sharer-title]]/hd:flex-none group-has-[[data-request]]/hd:hidden">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[var(--chalk-danger)]" />
          <b className="truncate font-semibold">{source ? `You’re sharing ${source}` : "You’re screen sharing"}</b>
        </div>
        <div ref={titleHost} className="contents" />
        <div ref={policyHost} className="contents group-has-[[data-request]]/hd:hidden" />
        {onChangeShare && !phone ? (
          <ChalkMenu
            trigger={
              <ChalkButton disabled={pending} className="!h-[34px] !bg-[var(--chalk-raised)] !px-3.5 !text-[var(--chalk-text)] hover:!bg-[var(--chalk-hover)]">
                Change
              </ChalkButton>
            }
          >
            {(
              [
                { surface: "monitor", label: "Entire screen" },
                { surface: "window", label: "Window" },
                { surface: "browser", label: "Browser tab" },
              ] as const
            ).map((option) => (
              <ChalkMenuItem key={option.surface} onClick={() => onChangeShare({ surface: option.surface, audio: option.surface === "browser" })}>
                {option.label}
              </ChalkMenuItem>
            ))}
          </ChalkMenu>
        ) : null}
        {onStopSharing ? (
          <ChalkButton disabled={pending} tone="danger" className="!h-[34px] !bg-[var(--chalk-danger)] !px-3.5 !text-white hover:!bg-[var(--chalk-danger-hover)]" onClick={onStopSharing}>
            Stop sharing
          </ChalkButton>
        ) : null}
      </div>
    </div>
  );
}
