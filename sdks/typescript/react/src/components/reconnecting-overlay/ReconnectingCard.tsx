import { SignalFull02Icon, WifiOffIcon } from "../../utils/icons";

export interface ReconnectingCardProps {
  readonly headline: string;
  readonly detail: string;
  readonly offline?: boolean;
}

export function offlineNotice(online: boolean, pending: string | null): { readonly headline: string; readonly detail: string } {
  return {
    headline: online ? "Reconnecting…" : "You're offline",
    detail: pending ? `${pending} will send when you’re back.` : online ? "You’ll be back in the call on your own. This usually takes a few seconds." : "You’ll rejoin as soon as your connection is back.",
  };
}

/** Non-blocking notice over a dimmed call: the call stays usable while it recovers. */
export function ReconnectingCard({ headline, detail, offline = false }: ReconnectingCardProps) {
  const Icon = offline ? WifiOffIcon : SignalFull02Icon;
  return (
    <div role="status" data-part="connection-notice" style={{ pointerEvents: "none", background: "color-mix(in srgb, var(--chalk-canvas) 55%, transparent)" }} className="absolute inset-0 z-50 flex items-center justify-center px-6 text-[var(--chalk-text)]">
      <div className="flex w-full max-w-[320px] flex-col items-center gap-1 rounded-2xl border border-[var(--chalk-line-strong)] bg-[var(--chalk-surface)] px-6 pb-5 pt-6 text-center">
        <Icon aria-hidden="true" className="mb-2 h-6 w-6 text-[var(--chalk-muted-text)]" />
        <p className="text-[15px] font-semibold">{headline}</p>
        <p className="text-[13px] leading-[1.4] text-[var(--chalk-soft-text)]">{detail}</p>
        <span aria-hidden="true" className="mt-4 h-0.5 w-20 rounded-full bg-[var(--chalk-line-strong)]">
          <span className="block h-full w-full animate-pulse rounded-full bg-[var(--chalk-muted-text)] motion-reduce:animate-none" />
        </span>
      </div>
    </div>
  );
}
