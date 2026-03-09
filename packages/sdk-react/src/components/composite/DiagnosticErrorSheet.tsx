import React, { useState, useMemo } from "react";
import { cn } from "../../utils/cn";
import { Cancel01Icon, ArrowDown01Icon, ArrowUp01Icon, RefreshIcon, ArrowLeft01Icon } from "../../utils/icons";

export interface DiagnosticErrorSheetProps {
  error: string;
  supportCode?: string;
  onRetry?: () => void;
  onBack?: () => void;
  className?: string;
}

/**
 * A premium, minimalist diagnostic error sheet for Chalk.
 * Handles different error types (auth, network, server) with unique visuals and actions.
 */
export const DiagnosticErrorSheet = React.memo<DiagnosticErrorSheetProps>(({ error, supportCode, onRetry, onBack, className }) => {
  const [showDetails, setShowDetails] = useState(false);

  // Analyze error to determine the best human-readable message and actions
  const errorInfo = useMemo(() => {
    const lowerError = error.toLowerCase();

    if (lowerError.includes("api key") || lowerError.includes("auth") || lowerError.includes("token")) {
      return {
        title: "Authentication Issue",
        message: "We couldn't verify your access to this room. This usually happens due to an expired link or an invalid API key.",
        type: "auth" as const,
      };
    }

    if (lowerError.includes("timeout") || lowerError.includes("network") || lowerError.includes("reach")) {
      return {
        title: "Connection Timed Out",
        message: "It's taking longer than expected to reach our servers. Please check your internet connection and try again.",
        type: "network" as const,
      };
    }

    return {
      title: "Something went wrong",
      message: "An unexpected error occurred while trying to join the room. Our team has been notified.",
      type: "server" as const,
    };
  }, [error]);

  return (
    <div className={cn("fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/40 backdrop-blur-sm animate-in fade-in duration-300", className)}>
      <div
        className="absolute inset-0"
        onClick={(e) => {
          e.stopPropagation();
          onBack?.();
        }}
        aria-hidden="true"
      />

      <div
        className={cn("relative w-full max-w-lg bg-background border-t sm:border border-border shadow-2xl overflow-hidden animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-8 sm:zoom-in-95 duration-500 ease-out sm:rounded-3xl", "rounded-t-[32px]")}
        style={{
          background: "var(--chalk-lobby-glass-bg)",
          borderColor: "var(--chalk-lobby-glass-border)",
          backdropFilter: "blur(40px)",
        }}
      >
        {/* Mobile Drag Handle */}
        <div className="sm:hidden w-full pt-4 flex justify-center">
          <div className="w-12 h-1.5 bg-muted/30 rounded-full" />
        </div>

        {/* Close Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBack?.();
          }}
          className="absolute top-6 right-6 p-2 z-10 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all duration-200"
          aria-label="Close"
        >
          <Cancel01Icon size={20} />
        </button>

        <div className="px-8 pt-8 pb-10 flex flex-col items-center text-center">
          {/* Custom Minimalist "Lost Link" Illustration */}
          <div className="h-32 w-full flex items-center justify-center mb-8 relative">
            <svg width="160" height="100" viewBox="0 0 160 100" fill="none" xmlns="http://www.w3.org/2000/svg" className="animate-pulse-subtle">
              {/* Central Hub */}
              <circle cx="80" cy="50" r="8" className="fill-foreground/10" />
              <circle cx="80" cy="50" r="4" className="fill-primary" />

              {/* Peripheral Nodes & Connections */}
              <g className="animate-float">
                {/* Node 1 - Active */}
                <line x1="80" y1="50" x2="30" y2="30" className="stroke-primary/40" strokeWidth="2" />
                <circle cx="30" cy="30" r="5" className="fill-primary/20" />
                <circle cx="30" cy="30" r="2.5" className="fill-primary" />

                {/* Node 2 - Active */}
                <line x1="80" y1="50" x2="130" y2="30" className="stroke-primary/40" strokeWidth="2" />
                <circle cx="130" cy="30" r="5" className="fill-primary/20" />
                <circle cx="130" cy="30" r="2.5" className="fill-primary" />

                {/* Node 3 - Disconnected (The Error) */}
                <line x1="80" y1="50" x2="80" y2="90" className="stroke-destructive/30" strokeWidth="2" strokeDasharray="4 4">
                  <animate attributeName="stroke-dashoffset" from="0" to="8" dur="1s" repeatCount="indefinite" />
                </line>
                <circle cx="80" cy="90" r="6" className="fill-destructive/10 animate-pulse" />
                <circle cx="80" cy="90" r="3" className="fill-destructive" />
              </g>
            </svg>

            {/* Soft Ambient Glows */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-primary/5 blur-3xl rounded-full -z-10" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-destructive/10 blur-2xl rounded-full -z-10 animate-pulse" />
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-foreground mb-3">{errorInfo.title}</h2>

          <p className="text-base text-muted-foreground max-w-sm leading-relaxed mb-10">{errorInfo.message}</p>

          {/* Technical Details Accordion */}
          <div className="w-full mb-8">
            <button onClick={() => setShowDetails(!showDetails)} className="flex items-center gap-2 mx-auto text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground transition-all duration-200 group">
              {showDetails ? <ArrowUp01Icon size={12} /> : <ArrowDown01Icon size={12} />}
              Technical Details
              <div className="h-px w-0 group-hover:w-4 bg-foreground/20 transition-all duration-300" />
            </button>

            {showDetails && (
              <div className="mt-4 p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-border/50 text-left overflow-hidden animate-in slide-in-from-top-2 duration-300">
                <pre className="text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">{error}</pre>
              </div>
            )}
          </div>

          {supportCode && (
            <div className="w-full mb-8 rounded-xl border border-border/50 bg-black/5 dark:bg-white/5 p-4 text-left">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70">Support Code</p>
              <p className="mt-2 text-xs font-mono text-foreground break-all">{supportCode}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col sm:flex-row items-center gap-3 w-full">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.();
              }}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 transition-all hover:bg-primary/90 active:scale-[0.98] shadow-lg shadow-primary/20"
            >
              <RefreshIcon size={18} />
              Try Again
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBack?.();
              }}
              className="w-full h-12 rounded-xl bg-transparent border border-border text-foreground font-semibold flex items-center justify-center gap-2 transition-all hover:bg-muted/5 active:scale-[0.98]"
            >
              <ArrowLeft01Icon size={18} />
              Go Back
            </button>
          </div>
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes chalk-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes chalk-pulse-subtle {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }
        .animate-float {
          animation: chalk-float 3s ease-in-out infinite;
        }
        .animate-pulse-subtle {
          animation: chalk-pulse-subtle 4s ease-in-out infinite;
        }
      `,
        }}
      />
    </div>
  );
});

DiagnosticErrorSheet.displayName = "DiagnosticErrorSheet";
