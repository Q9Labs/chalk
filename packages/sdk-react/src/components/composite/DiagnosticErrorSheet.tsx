import React, { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { Cancel01Icon, ArrowDown01Icon, ArrowUp01Icon, RefreshIcon, ArrowLeft01Icon, InformationCircleIcon, WifiOffIcon, Shield01Icon, Download01Icon } from "../../utils/icons";
import { downloadDebugText, prepareFullDebugExport, type PreparedDebugExport } from "../../utils/debugExport";

export interface DiagnosticErrorSheetProps {
  error: string;
  supportCode?: string;
  onRetry?: () => void;
  onBack?: () => void;
  className?: string;
}

export const DiagnosticErrorSheet = React.memo<DiagnosticErrorSheetProps>(({ error, supportCode, onRetry, onBack, className }) => {
  const [showDetails, setShowDetails] = useState(true);
  const [debugExportState, setDebugExportState] = useState<"idle" | "preparing" | "failed" | "downloaded">("idle");
  const [preparedDebugExport, setPreparedDebugExport] = useState<PreparedDebugExport | null>(null);
  const downloadLinkRef = useRef<HTMLButtonElement | null>(null);

  const logCopyDebug = (label: string, details: Record<string, unknown>) => {
    console.groupCollapsed(`[chalk][diagnostic-error-sheet] ${label}`);
    for (const [key, value] of Object.entries(details)) {
      console.log(key, value);
    }
    console.groupEnd();
  };

  // Analyze error to determine the best human-readable message and actions
  const errorInfo = useMemo(() => {
    const lowerError = error.toLowerCase();

    if (lowerError.includes("api key") || lowerError.includes("auth") || lowerError.includes("token")) {
      return {
        title: "Let's get you back in",
        message: "It looks like your link expired or isn't quite right. No worries, simply request a new link to join.",
        type: "auth" as const,
        Icon: Shield01Icon,
      };
    }

    if (lowerError.includes("timeout") || lowerError.includes("network") || lowerError.includes("reach")) {
      return {
        title: "Quick connection hiccup",
        message: "We're having a little trouble reaching the network right now. A quick refresh usually does the trick.",
        type: "network" as const,
        Icon: WifiOffIcon,
      };
    }

    return {
      title: "Just a small bump in the road",
      message: "We encountered a routine hiccup while getting you set up. Just click try again and we'll handle the rest.",
      type: "server" as const,
      Icon: InformationCircleIcon,
    };
  }, [error]);

  const { Icon } = errorInfo;

  useEffect(() => {
    let cancelled = false;
    setDebugExportState("preparing");
    setPreparedDebugExport(null);
    logCopyDebug("prepare:start", {
      error,
      supportCode: supportCode ?? null,
      previousState: debugExportState,
    });

    void prepareFullDebugExport({
      source: "diagnostic-error-sheet",
      error,
      supportCode: supportCode ?? null,
    })
      .then((prepared) => {
        if (cancelled) return;
        setPreparedDebugExport(prepared);
        setDebugExportState("idle");
        logCopyDebug("prepare:ready", {
          textBytes: prepared.diagnostics.textBytes ?? null,
          clipboardAvailable: prepared.diagnostics.clipboardAvailable,
          clipboardWriteTextAvailable: prepared.diagnostics.clipboardWriteTextAvailable,
          clipboardWriteAvailable: prepared.diagnostics.clipboardWriteAvailable,
          clipboardItemAvailable: prepared.diagnostics.clipboardItemAvailable,
        });
      })
      .catch((preparationError) => {
        if (cancelled) return;
        setDebugExportState("failed");
        logCopyDebug("prepare:failed", {
          error,
          supportCode: supportCode ?? null,
          preparationError,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [error, supportCode]);

  const handleDebugDownload = async () => {
    logCopyDebug("download:click", {
      debugExportState,
      hasPreparedDebugExport: Boolean(preparedDebugExport),
      supportCode: supportCode ?? null,
      error,
    });

    const prepared = preparedDebugExport ?? (await prepareFullDebugExport({
      source: "diagnostic-error-sheet",
      error,
      supportCode: supportCode ?? null,
    }));
    setPreparedDebugExport(prepared);
    downloadDebugText(prepared.text);
    setDebugExportState("downloaded");
    logCopyDebug("download:result", {
      outcome: "downloaded",
      diagnostics: prepared.diagnostics,
      textBytes: prepared.diagnostics.textBytes ?? null,
    });
    window.setTimeout(() => setDebugExportState("idle"), 2500);
  };

  return (
    <div className={cn("fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-background/60 backdrop-blur-md animate-in fade-in duration-500 font-app", className)}>
      <div
        className="absolute inset-0"
        onClick={(e) => {
          e.stopPropagation();
          onBack?.();
        }}
        aria-hidden="true"
      />

      <div
        className={cn("relative w-full max-w-[420px] bg-card border-t sm:border border-border/60 shadow-2xl overflow-hidden animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-8 sm:zoom-in-95 duration-700 ease-[cubic-bezier(0.2,0,0,1)] sm:rounded-[32px]", "rounded-t-[32px]")}
        style={{
          background: "var(--chalk-lobby-glass-bg, hsl(var(--card)))",
          backdropFilter: "blur(40px)",
        }}
      >
        <div className="absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none -z-10" />

        {/* Mobile Drag Handle */}
        <div className="sm:hidden w-full pt-4 flex justify-center text-foreground absolute top-0 left-0 z-20 pointer-events-none">
          <div className="w-12 h-1.5 bg-muted/60 rounded-full" />
        </div>

        {/* Close Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBack?.();
          }}
          className="absolute top-5 right-5 p-2 z-20 rounded-full bg-muted/30 hover:bg-muted text-muted-foreground hover:text-foreground transition-all duration-200"
          aria-label="Close"
        >
          <Cancel01Icon size={18} />
        </button>

        <div className="px-8 pt-12 pb-8 flex flex-col items-center text-center relative z-10">
          {/* Reassuring Animation */}
          <div className="h-28 w-full flex items-center justify-center mb-6 relative">
            <div className="absolute inset-0 flex items-center justify-center animate-friendly-float">
              <div className="absolute w-24 h-24 bg-primary/5 rounded-full animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite]" />
              <div className="absolute w-16 h-16 bg-primary/10 rounded-full animate-[pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite]" />
              <div className="relative w-12 h-12 bg-primary/15 rounded-full flex items-center justify-center shadow-lg shadow-primary/10 border border-primary/20 backdrop-blur-md">
                <Icon size={22} className="text-primary" />
              </div>
            </div>
          </div>

          <h2 className="font-display text-[1.6rem] font-bold tracking-tight text-foreground mb-4 leading-snug">{errorInfo.title}</h2>

          <p className="text-[15px] text-muted-foreground max-w-[320px] leading-normal mb-8">{errorInfo.message}</p>

          {/* Actions */}
          <div className="flex flex-col w-full gap-3 mb-6">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.();
              }}
              className="w-full h-[3rem] rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 transition-all hover:bg-primary/90 active:scale-[0.98] shadow-md shadow-primary/20 text-[15px]"
            >
              <RefreshIcon size={18} />
              Try Again
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBack?.();
              }}
              className="w-full h-[3rem] rounded-2xl bg-transparent border border-border text-foreground font-semibold flex items-center justify-center gap-2 transition-all hover:bg-muted/50 active:scale-[0.98] text-[15px]"
            >
              <ArrowLeft01Icon size={18} />
              Go Back
            </button>
          </div>

          <div className="mb-6 flex w-full flex-wrap justify-center gap-3">
            <button
              ref={downloadLinkRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleDebugDownload();
              }}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-border bg-muted/40 px-4 text-[14px] font-semibold text-foreground transition-all hover:bg-muted/60 active:scale-[0.98]"
            >
              <Download01Icon size={18} />
              {debugExportState === "preparing"
                ? "Preparing Debug..."
                : debugExportState === "downloaded"
                  ? "Downloaded Debug TXT"
                  : "Download Debug TXT"}
            </button>
          </div>

          <p className="mb-6 max-w-[320px] text-[12px] leading-normal text-muted-foreground">
            Download the debug file and share it with your support admin so they can help investigate the issue.
          </p>

          {/* Technical Details Accordion */}
          <div className="w-full">
            <button type="button" onClick={() => setShowDetails(!showDetails)} className="flex items-center justify-center gap-1.5 mx-auto text-[13px] font-medium text-muted-foreground/70 hover:text-foreground transition-all duration-200 group">
              {showDetails ? <ArrowUp01Icon size={14} /> : <ArrowDown01Icon size={14} />}
              <span>Technical details</span>
            </button>

            <div className={cn("grid transition-all duration-300 ease-in-out w-full", showDetails ? "grid-rows-[1fr] opacity-100 mt-5" : "grid-rows-[0fr] opacity-0")}>
              <div className="overflow-hidden text-left min-h-0">
                {supportCode && (
                  <div className="mb-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-muted-foreground/60 mb-1.5 px-1">Support Code</p>
                    <p className="text-xs font-mono text-foreground break-all bg-muted/40 p-2.5 rounded-xl border border-border/50">{supportCode}</p>
                  </div>
                )}
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-muted-foreground/60 mb-1.5 px-1">Error Log</p>
                  <div className="p-2.5 rounded-xl bg-muted/40 border border-border/50">
                    <pre className="text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-32 scrollbar-thin">{error}</pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes friendly-float {
          0%, 100% { transform: translateY(0px) scale(1); }
          50% { transform: translateY(-6px) scale(1.02); }
        }
        .animate-friendly-float {
          animation: friendly-float 4s ease-in-out infinite;
        }
      `,
        }}
      />
    </div>
  );
});

DiagnosticErrorSheet.displayName = "DiagnosticErrorSheet";
