import type React from "react";

import { useHaptics } from "../../../hooks/ui/useHaptics";
import { cn } from "../../../utils/cn";

interface PreJoinJoinPanelProps {
  displayName: string;
  isLoading: boolean;
  canJoin: boolean;
  participantGradient: string;
  onDisplayNameChange: (value: string) => void;
  onJoin: () => void;
}

export function PreJoinJoinPanel({ displayName, isLoading, canJoin, participantGradient: _participantGradient, onDisplayNameChange, onJoin }: PreJoinJoinPanelProps): React.JSX.Element {
  const { trigger } = useHaptics({
    enabled: canJoin && !isLoading,
  });

  return (
    <div className="flex flex-col items-start text-left space-y-6 w-full max-w-sm lg:justify-self-end">
      <div className="space-y-2 text-left">
        <h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-(--foreground)">Ready to join?</h1>
        <p className="text-(--muted-foreground) text-base">You'll be in a waiting room before entering the call</p>
      </div>

      <div className="w-full space-y-4">
        <div className="w-full">
          <label htmlFor="display-name" className="sr-only">
            Display Name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Enter your name"
            disabled={isLoading}
            className={cn(
              "w-full h-12 px-4 rounded-xl text-base transition-all outline-none text-(--foreground) placeholder:text-(--muted-foreground) disabled:opacity-50",
              "border bg-[var(--chalk-lobby-glass-bg)] backdrop-blur-md shadow-sm",
              "border-[var(--chalk-lobby-glass-border)]",
              "focus-visible:border-[var(--primary)] focus-visible:ring-4 focus-visible:ring-[var(--primary)]/20 focus-visible:shadow-[0_0_15px_var(--primary)]",
            )}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            void trigger("success");
            onJoin();
          }}
          disabled={!canJoin || isLoading}
          className={cn(
            "relative w-full h-12 rounded-full font-semibold text-base text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden group",
            "outline-none focus-visible:ring-4 focus-visible:ring-[var(--primary)]/30",
            "shadow-lg hover:shadow-xl hover:opacity-95",
          )}
          style={{
            backgroundColor: "var(--primary)",
          }}
        >
          <span className="relative z-10 flex items-center gap-2">{isLoading ? "Joining..." : "Ask to join"}</span>
        </button>
      </div>
    </div>
  );
}
