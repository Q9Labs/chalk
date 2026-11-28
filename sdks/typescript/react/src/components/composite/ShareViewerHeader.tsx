import { usePhoneCall } from "../../internal/call-width";
import { StageIcon } from "../stage/StageIcon";

/** The header above someone else's shared screen. Their name sits on the left; the drawing controls are portalled into the slot on the right. */
export function ShareViewerHeader({ name, withAudio, host }: { readonly name: string; readonly withAudio: boolean; readonly host: (element: HTMLElement | null) => void }) {
  const phone = usePhoneCall();
  return (
    <div
      data-part="share-viewer-header"
      data-phone={phone ? "" : undefined}
      role="group"
      aria-label="Screen controls"
      className={`flex ${phone ? "h-12 pl-2.5" : "h-13 pl-3.5"} shrink-0 items-center gap-2 border-b border-[var(--chalk-line)] bg-[var(--chalk-surface)] pr-2 text-(length:--type-body) text-[var(--chalk-text)]`}
    >
      <StageIcon name="share" size={18} className="chalk-share-icon shrink-0 text-[var(--chalk-soft-text)]" />
      <span dir="auto" className="chalk-share-name min-w-0 flex-1 truncate font-semibold [unicode-bidi:plaintext]">
        {name}
      </span>
      {withAudio ? <StageIcon name="volume" size={14} aria-label="With share audio" className="shrink-0 text-[var(--chalk-soft-text)]" /> : null}
      <div ref={host} className="chalk-hd-slot contents" />
    </div>
  );
}
