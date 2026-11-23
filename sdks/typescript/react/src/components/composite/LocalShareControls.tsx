import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import { ChalkButton, ChalkMenu, ChalkMenuItem } from "../chalk-ui";

export function LocalShareControls({ capture, pending, onChangeShare, onStopSharing }: { readonly capture?: ScreenShareCapture; readonly pending: boolean; readonly onChangeShare?: (options: ScreenShareOptions) => void; readonly onStopSharing?: () => void }) {
  const source = capture?.surface === "window" ? "a window" : capture?.surface === "browser" ? "a tab" : capture?.surface === "monitor" ? "your screen" : null;
  return (
    <div data-part="share-local-overlay" role="group" aria-label="Your share" className="absolute top-2.5 right-2.5 left-2.5 z-30 flex items-center gap-2 rounded-(--corner-xl) bg-[var(--chalk-overlay-strong)] p-2 pl-3.5 text-[var(--chalk-on-overlay)] max-[640px]:flex-wrap">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="truncate font-semibold">{source ? `You’re sharing ${source}` : "You’re screen sharing"}</b>
        {capture?.surface === "monitor" || capture?.surface === "browser" ? <span className="text-(length:--type-caption) text-[var(--chalk-on-overlay)]">Seeing a mirror effect? That’s normal when you share {capture.surface === "browser" ? "this tab" : "your whole screen"}.</span> : null}
      </div>
      {onChangeShare ? (
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
  );
}
