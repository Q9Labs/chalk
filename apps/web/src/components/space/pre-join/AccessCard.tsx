import { Loading01Icon, Video01Icon, VideoOffIcon } from "@q9labsai/chalk-react/utils";

export type AccessReason = "ask" | "blocked";

const isChrome = () => /Chrome\//u.test(navigator.userAgent) && !/Edg\/|OPR\//u.test(navigator.userAgent);

const stepRow = "flex items-center gap-2 rounded-lg px-2 py-1.5 text-(length:--type-caption) text-[var(--chalk-text)]";

function StepBadge({ step }: { readonly step: number }) {
  return <span className="grid size-4 flex-none place-items-center rounded-full bg-[var(--chalk-accent)] text-(length:--type-micro) font-semibold text-[var(--chalk-accent-text)]">{step}</span>;
}

/** Chrome's own way back in: the site settings button next to the address, then the two switches. */
function ChromeSteps() {
  return (
    <div aria-hidden="true" className="grid gap-2 rounded-2xl bg-[var(--chalk-hover)] p-3">
      <div className={`${stepRow} bg-[var(--chalk-surface)]`}>
        <span className="flex-1">{globalThis.location.hostname}</span>
        <StepBadge step={1} />
      </div>
      <div className="grid gap-0.5 rounded-lg bg-[var(--chalk-surface)] p-1">
        {["Camera", "Microphone"].map((name, index) => (
          <div key={name} className={stepRow}>
            <span className="flex-1">{name}</span>
            <span className="h-3.5 w-6 flex-none rounded-full bg-[var(--chalk-pressed)]" />
            <StepBadge step={index + 2} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The permission card from the preview step: ask first, then the blocked state with the way back in. */
export function AccessCard({ reason, requesting, onDismiss, onAllow }: { readonly reason: AccessReason; readonly requesting: boolean; readonly onDismiss: () => void; readonly onAllow: () => void }) {
  const blocked = reason === "blocked";
  const Icon = blocked ? VideoOffIcon : Video01Icon;
  return (
    <div role="group" aria-labelledby="access-card-title" className="grid gap-2 p-2 text-[var(--chalk-text)]">
      <div className="flex items-start gap-3 px-2 pt-2">
        <span className={`grid size-10 flex-none place-items-center rounded-full bg-[var(--chalk-hover)] ${blocked ? "text-[var(--chalk-danger-text)]" : ""}`}>
          <Icon size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="access-card-title" className="pt-px text-(length:--type-body-lg) font-semibold leading-snug">
            {blocked ? "Camera and microphone are blocked" : "Turn on camera and microphone?"}
          </h3>
          <p className="mt-0.5 text-(length:--type-body-sm) leading-[1.4] text-[var(--chalk-muted-text)]">{blocked ? `Allow them for this site in ${isChrome() ? "Chrome" : "your browser"}.` : "Your browser asks next. Only you see the preview until you join."}</p>
        </div>
      </div>
      {blocked && isChrome() ? <ChromeSteps /> : null}
      <div className="flex gap-2">
        <button type="button" data-part="pill-button" data-chalk-variant="outline" data-chalk-tone="neutral" className="chalk-pill-button !h-10 flex-1" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" data-part="pill-button" data-chalk-variant="solid" data-chalk-tone="neutral" className="chalk-pill-button !h-10 flex-1" onClick={onAllow} disabled={requesting} aria-busy={requesting || undefined}>
          {requesting ? <Loading01Icon size={16} className="animate-spin" aria-hidden="true" /> : blocked ? "Try again" : "Turn on"}
        </button>
      </div>
    </div>
  );
}
