import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import { usePhoneCall } from "../../internal/call-width";
import { ChalkButton, ChalkMenu, ChalkMenuItem } from "../chalk-ui";

/**
 * The bar above your own shared screen. It sits in the tile's flow, so it never covers the preview.
 * The drawing pill and the second row are portalled in through the two hosts.
 */
export function LocalShareControls({
  capture,
  pending,
  onChangeShare,
  onStopSharing,
  policyHost,
  noticeHost,
}: {
  readonly capture?: ScreenShareCapture;
  readonly pending: boolean;
  readonly onChangeShare?: (options: ScreenShareOptions) => void;
  readonly onStopSharing?: () => void;
  readonly policyHost?: (element: HTMLElement | null) => void;
  readonly noticeHost?: (element: HTMLElement | null) => void;
}) {
  const phone = usePhoneCall();
  const source = capture?.surface === "window" ? "a window" : capture?.surface === "browser" ? "a tab" : capture?.surface === "monitor" ? "your screen" : null;
  const mirrorHint = !phone && (capture?.surface === "monitor" || capture?.surface === "browser");
  return (
    <div data-part="share-local-overlay" role="group" aria-label="Your share" className="group/bar relative z-30 m-2 flex shrink-0 flex-col gap-2 rounded-(--corner-xl) bg-[var(--chalk-overlay-strong)] p-2 pl-3.5 text-[var(--chalk-on-overlay)]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <b className="truncate font-semibold">{source ? `You’re sharing ${source}` : "You’re screen sharing"}</b>
          {mirrorHint ? <span className="text-(length:--type-caption) group-has-[[data-part=sharer-notice]]/bar:hidden">Seeing a mirror effect? That’s normal when you share {capture?.surface === "browser" ? "this tab" : "your whole screen"}.</span> : null}
        </div>
        <div ref={policyHost} className="contents" />
        {onChangeShare && !phone ? (
          <ChalkMenu
            trigger={
              <ChalkButton disabled={pending} className="!h-8 !bg-[var(--chalk-on-overlay)]/[.14] !px-3 !text-[var(--chalk-on-overlay)] hover:!bg-[var(--chalk-on-overlay)]/[.22]">
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
          <ChalkButton disabled={pending} tone="danger" className="!h-8 !bg-[var(--chalk-danger)] !px-3 !text-[var(--chalk-on-overlay)] hover:!bg-[var(--chalk-danger-hover)]" onClick={onStopSharing}>
            Stop sharing
          </ChalkButton>
        ) : null}
      </div>
      <div ref={noticeHost} className="contents" />
    </div>
  );
}
