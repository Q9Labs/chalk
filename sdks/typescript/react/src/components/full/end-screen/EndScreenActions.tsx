import { Home01Icon, PlusSignIcon, RefreshIcon } from "../../../utils/icons";

interface EndScreenActionsProps {
  onRejoin?: () => void;
  onNewMeeting?: () => void;
  onGoHome?: () => void;
}

export function EndScreenActions({ onRejoin, onNewMeeting, onGoHome }: EndScreenActionsProps) {
  return (
    <div className="border-t border-[var(--border)] p-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {onRejoin && (
        <button type="button" onClick={onRejoin} className="col-span-2 sm:col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]">
          <RefreshIcon size={20} className="text-[var(--muted-foreground)]" />
          Rejoin
        </button>
      )}

      {onNewMeeting && (
        <button type="button" onClick={onNewMeeting} className="col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]">
          <PlusSignIcon size={20} className="text-[var(--muted-foreground)]" />
          New Meeting
        </button>
      )}

      {onGoHome && (
        <button type="button" onClick={onGoHome} className="col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]">
          <Home01Icon size={20} className="text-[var(--muted-foreground)]" />
          Home
        </button>
      )}
    </div>
  );
}
