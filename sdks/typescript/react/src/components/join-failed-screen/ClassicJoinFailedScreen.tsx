import { useId } from "react";

import { ArrowLeft01Icon, Alert02Icon, RefreshIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import type { JoinFailedScreenProps } from "./JoinFailedScreen";

const DEFAULT_TITLE = "Couldn’t enter the Space";

/**
 * Presents a failed Space entry with enough context to recover or return to
 * the Entrance. The support code is intentionally plain text so people can
 * select and copy it without the component reaching for the clipboard.
 */
export function ClassicJoinFailedScreen({ title = DEFAULT_TITLE, message, supportCode, onRetry, onBack, className }: JoinFailedScreenProps): React.JSX.Element {
  const titleId = useId();
  const messageId = useId();
  const supportCodeLabelId = useId();
  const skin = useSkin();

  return (
    <main data-chalk data-chalk-skin={skin} className={cn("chalk-root chalk-textured-surface flex min-h-dvh items-center justify-center bg-[var(--chalk-app-canvas)] px-4 py-10 font-sans text-[var(--chalk-app-text)] sm:px-6", className)}>
      <section aria-labelledby={titleId} className="chalk-textured-surface w-full max-w-lg overflow-hidden rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] shadow-[var(--chalk-app-shadow-sm)]">
        <div className="flex flex-col items-center px-6 pb-7 pt-9 text-center sm:px-10 sm:pt-10">
          <div aria-hidden="true" className="mb-5 grid h-14 w-14 place-items-center rounded-full bg-[var(--chalk-app-danger)]/10 text-[var(--chalk-app-danger)]">
            <Alert02Icon size={28} strokeWidth={1.7} />
          </div>

          <div role="alert" aria-labelledby={titleId} aria-describedby={messageId} aria-atomic="true">
            <h1 id={titleId} className="text-2xl font-semibold tracking-[-0.03em] text-[var(--chalk-app-text)] sm:text-[28px]">
              {title}
            </h1>
            <p id={messageId} role="status" className="mt-3 text-sm leading-6 text-[var(--chalk-app-text-muted)] sm:text-base">
              {message}
            </p>
          </div>
        </div>

        {supportCode && (
          <div className="mx-6 mb-7 rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] px-4 py-3.5 text-left sm:mx-10">
            <p id={supportCodeLabelId} className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--chalk-app-text-muted)]">
              Support code
            </p>
            <code aria-labelledby={supportCodeLabelId} className="mt-1 block select-text break-all font-mono text-sm leading-5 text-[var(--chalk-app-text)]">
              {supportCode}
            </code>
          </div>
        )}

        <div role="group" aria-label="Entrance actions" className="flex flex-col gap-3 border-t border-[var(--chalk-app-line)] px-6 py-6 sm:flex-row sm:px-10">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[8px] bg-[var(--chalk-app-control-primary)] px-4 text-sm font-semibold !text-white transition-colors hover:bg-[var(--chalk-app-control-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-app-panel)]"
          >
            <RefreshIcon aria-hidden="true" size={17} />
            Try again
          </button>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[8px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] px-4 text-sm font-semibold text-[var(--chalk-app-text)] transition-colors hover:bg-[var(--chalk-app-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-app-panel)]"
          >
            <ArrowLeft01Icon aria-hidden="true" size={17} />
            Back to Entrance
          </button>
        </div>
      </section>
    </main>
  );
}
