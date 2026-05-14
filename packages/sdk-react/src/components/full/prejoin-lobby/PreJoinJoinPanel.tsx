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
    <div className="flex flex-col items-start text-left space-y-8 w-full max-w-sm lg:justify-self-end">
      <div className="space-y-3 text-left">
        <h1 className="text-4xl lg:text-5xl font-bold tracking-tight text-(--foreground)">Ready to join?</h1>
        <p className="text-(--muted-foreground) text-base leading-relaxed">You'll be in a waiting room before entering the call</p>
      </div>

      <div className="w-full space-y-4">
        <div className="w-full space-y-2">
          <label htmlFor="display-name" className="block text-sm font-medium text-(--foreground)">
            Your name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Enter your name"
            disabled={isLoading}
            className={cn(
              "w-full h-14 px-5 rounded-2xl text-base transition-all outline-none text-(--foreground) placeholder:text-(--muted-foreground) disabled:opacity-50",
              "border-2 bg-card border-border",
              "hover:border-border/80",
              "focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20",
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
            "relative w-full h-14 rounded-full font-semibold text-base text-white transition-all duration-200 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden group",
            "outline-none focus-visible:ring-4 focus-visible:ring-[var(--primary)]/30",
            "shadow-lg hover:shadow-xl hover:shadow-primary/25 hover:-translate-y-0.5",
            "before:absolute before:inset-0 before:bg-gradient-to-b before:from-white/20 before:to-transparent before:opacity-100",
          )}
          style={{
            backgroundColor: "var(--primary)",
          }}
        >
          <span className="relative z-10 flex items-center gap-2">
            {isLoading ? (
              <>
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Joining...
              </>
            ) : (
              "Ask to join"
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
