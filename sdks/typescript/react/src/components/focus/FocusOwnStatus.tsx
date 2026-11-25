import { useEffect, useState } from "react";
import { ChalkButton } from "../chalk-ui";
import { FOCUS_COPY } from "./focus-copy";
import type { TileFocus } from "../participant-grid/ParticipantGrid";

function title(reason: NonNullable<TileFocus["steppedAway"]>): string {
  return FOCUS_COPY.reasons[reason];
}

export function focusOwnState(focus: TileFocus): string {
  if (focus.steppedAway) return title(focus.steppedAway);
  if (focus.allowed && focus.appState !== "active") return FOCUS_COPY.allowed;
  if (focus.appState === "background") return FOCUS_COPY.notFocused;
  if (focus.appState === "inactive") return focus.windowed ? FOCUS_COPY.splitView : FOCUS_COPY.otherWindow;
  return FOCUS_COPY.focused;
}

/** The tracked person's always-visible own Focus state in the call header. */
export function FocusOwnStatus({ focus }: { readonly focus: TileFocus }) {
  const state = focusOwnState(focus);
  const attention = focus.appState !== undefined && focus.appState !== "active" && !focus.allowed && !focus.steppedAway;
  return (
    <span data-part="focus-own-status" role="status" aria-label={`${FOCUS_COPY.on}. ${state}`} className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-[var(--chalk-overlay)] px-2.5 py-1.5 text-xs font-medium text-[var(--chalk-on-overlay)]">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>{FOCUS_COPY.on}</span>
      <span className={attention ? "text-[var(--chalk-overlay-warning)]" : "opacity-70"}>{state}</span>
    </span>
  );
}

const STORAGE_KEY = "chalk.focus.notice.v1";

/** The one-time plain-language disclosure shown the first time Focus reporting reaches a person. */
export function FocusNotice({ focus, space }: { readonly focus?: TileFocus; readonly space: string }) {
  const [open, setOpen] = useState(false);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Persist the one-time disclosure only after the state first appears.
  useEffect(() => {
    if (!focus || typeof localStorage === "undefined") return;
    const key = `${STORAGE_KEY}:${space}`;
    if (localStorage.getItem(key) === "seen") return;
    setOpen(true);
    localStorage.setItem(key, "seen");
  }, [focus, space]);
  if (!focus || !open) return null;
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/35 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="focus-notice-title" className="w-full max-w-sm rounded-2xl bg-[var(--chalk-panel,var(--chalk-overlay))] p-5 text-center text-[var(--chalk-on-overlay)] shadow-(--elevation-toast)">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[var(--chalk-overlay-warning)]/15 text-[var(--chalk-overlay-warning)]">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </div>
        <h2 id="focus-notice-title" className="text-lg font-semibold">
          {FOCUS_COPY.noticeTitle}
        </h2>
        <p className="mt-2 text-sm leading-6 opacity-85">{FOCUS_COPY.noticeBody}</p>
        <ChalkButton variant="solid" className="mt-4 w-full" onClick={() => setOpen(false)} autoFocus>
          {FOCUS_COPY.noticeConfirm}
        </ChalkButton>
      </section>
    </div>
  );
}
