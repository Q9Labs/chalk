import React, { useCallback, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { Alert02Icon } from "../../utils/icons";

export interface TranscriptLineProps {
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  showTimestamp?: boolean;
  showSpeaker?: boolean;
  speakerColor?: string;
  isHost?: boolean;
  isLocalParticipant?: boolean;
  showAvatar?: boolean;
  showHeader?: boolean;
  searchHighlight?: string;
  isCurrentMatch?: boolean;
  className?: string;
}

function getInitials(name: string): string {
  if (!name || name.trim() === "") return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (
    parts
      .slice(0, 2)
      .map((n) => n[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query || query.trim() === "") return text;

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, i) => {
    if (part.toLowerCase() === query.toLowerCase()) {
      return (
        <mark key={i} className="bg-warning/40 text-foreground rounded-sm px-0.5">
          {part}
        </mark>
      );
    }
    return part;
  });
}

export const TranscriptLine = React.memo<TranscriptLineProps>(
  ({ speaker, speakerId, text, timestamp, isInterim = false, confidence = 1.0, showTimestamp = true, showSpeaker = true, speakerColor, isHost = false, isLocalParticipant = false, showAvatar = true, showHeader = true, searchHighlight, isCurrentMatch = false, className }) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [copied, setCopied] = useState(false);

    const timeString = useMemo(
      () =>
        new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(timestamp),
      [timestamp],
    );

    const initials = useMemo(() => getInitials(speaker), [speaker]);
    const isLowConfidence = confidence < 0.7;
    const confidencePercent = Math.round(confidence * 100);

    const handleCopyTimestamp = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(timeString);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // Clipboard access denied
      }
    }, [timeString]);

    const renderedText = useMemo(() => (searchHighlight ? highlightText(text, searchHighlight) : text), [text, searchHighlight]);

    return (
      <div
        className={cn("group relative rounded-lg transition-all duration-200", !prefersReducedMotion && !isInterim && "chalk-animate-transcript-in", isCurrentMatch && "ring-2 ring-primary/50 bg-primary/5", className)}
        style={speakerColor ? ({ "--primary": speakerColor } as React.CSSProperties) : undefined}
        role="listitem"
        aria-live={isInterim ? "off" : "polite"}
        data-speaker-id={speakerId}
        data-transcript-match={isCurrentMatch || undefined}
      >
        <div className="flex gap-3 p-3">
          {/* Avatar */}
          {showAvatar && showSpeaker && showHeader && (
            <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium text-white" style={{ backgroundColor: "var(--primary)" }} aria-hidden="true">
              {initials}
            </div>
          )}

          <div className="flex-1 min-w-0">
            {/* Header row: Name, Role Badge, Timestamp */}
            {showHeader && showSpeaker && (
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-sm truncate" style={{ color: speakerColor || "var(--foreground)" }}>
                  {speaker}
                </span>

                {/* Role badges */}
                {isHost && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/15 text-primary">Host</span>}
                {isLocalParticipant && !isHost && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">You</span>}

                {/* Timestamp - click to copy */}
                {showTimestamp && (
                  <button onClick={handleCopyTimestamp} className={cn("ml-auto text-xs transition-colors", copied ? "text-primary" : "text-muted-foreground hover:text-foreground")} title={copied ? "Copied!" : "Click to copy timestamp"}>
                    {copied ? "Copied!" : timeString}
                  </button>
                )}
              </div>
            )}

            {/* Transcript text */}
            <div className={cn("text-sm leading-relaxed break-words", isInterim ? "text-muted-foreground/70" : "text-foreground", isLowConfidence && !isInterim && "chalk-low-confidence")} title={isLowConfidence && !isInterim ? `Low confidence: ${confidencePercent}%` : undefined}>
              {renderedText}

              {/* Low confidence indicator */}
              {isLowConfidence && !isInterim && (
                <span className="inline-flex items-center ml-1.5 text-warning" title={`Confidence: ${confidencePercent}%`}>
                  <Alert02Icon className="w-3.5 h-3.5" />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);

TranscriptLine.displayName = "TranscriptLine";
