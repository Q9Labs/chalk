import { useId } from "react";

import { ChalkAlert, ChalkBadge, ChalkButton, ChalkDivider, ChalkPanel } from "../chalk-ui";
import { ArrowLeft01Icon, Alert02Icon, RefreshIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";

const DEFAULT_TITLE = "Couldn’t enter the Space";

export interface JoinFailedScreenProps {
  readonly title?: string;
  readonly message: string;
  readonly supportCode?: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly className?: string;
}

/**
 * Presents a failed Space entry with enough context to recover or return to
 * the Entrance. The support code is intentionally plain text so people can
 * select and copy it without the component reaching for the clipboard.
 */
export function JoinFailedScreen({ title = DEFAULT_TITLE, message, supportCode, onRetry, onBack, className }: JoinFailedScreenProps): React.JSX.Element {
  const titleId = useId();
  const messageId = useId();
  const supportCodeLabelId = useId();

  return (
    <main data-chalk className={cn("chalk-root chalk-textured-surface flex min-h-dvh items-center justify-center bg-[var(--chalk-app-canvas)] px-4 py-10 font-sans text-[var(--chalk-app-text)] sm:px-6", className)}>
      <section aria-labelledby={titleId} className="w-full max-w-lg">
        <ChalkPanel className="p-0" tone="neutral">
          <div className="flex flex-col items-center px-6 pb-7 pt-9 text-center sm:px-10 sm:pt-10">
            <ChalkBadge aria-hidden="true" tone="danger" className="mb-5 size-14 min-h-0 min-w-0 p-0 text-[var(--chalk-app-danger)]">
              <Alert02Icon size={28} strokeWidth={1.7} />
            </ChalkBadge>

            <ChalkAlert role="alert" tone="danger" aria-labelledby={titleId} aria-describedby={messageId} aria-atomic="true" className="p-0 text-center">
              <h1 id={titleId} className="text-2xl font-semibold tracking-[-0.03em] text-[var(--chalk-app-text)] sm:text-[28px]">
                {title}
              </h1>
              <p id={messageId} role="status" className="mt-3 text-sm leading-6 text-[var(--chalk-app-text-muted)] sm:text-base">
                {message}
              </p>
            </ChalkAlert>
          </div>

          {supportCode && (
            <ChalkPanel className="mx-6 mb-7 p-4 text-left sm:mx-10" tone="neutral">
              <p id={supportCodeLabelId} className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--chalk-app-text-muted)]">
                Support code
              </p>
              <code aria-labelledby={supportCodeLabelId} className="mt-1 block select-text break-all font-mono text-sm leading-5 text-[var(--chalk-app-text)]">
                {supportCode}
              </code>
            </ChalkPanel>
          )}

          <ChalkDivider className="mx-6 my-0 sm:mx-10" />
          <div role="group" aria-label="Entrance actions" className="flex flex-col gap-3 px-6 py-6 sm:flex-row sm:px-10">
            <ChalkButton type="button" onClick={onRetry} variant="solid" tone="accent" className="min-h-11 flex-1 text-sm font-semibold !text-[var(--chalk-app-control-active-text)]">
              <RefreshIcon aria-hidden="true" size={17} />
              Try again
            </ChalkButton>
            <ChalkButton type="button" onClick={onBack} variant="outline" tone="neutral" className="min-h-11 flex-1 text-sm font-semibold text-[var(--chalk-app-text)]">
              <ArrowLeft01Icon aria-hidden="true" size={17} />
              Back to Entrance
            </ChalkButton>
          </div>
        </ChalkPanel>
      </section>
    </main>
  );
}
