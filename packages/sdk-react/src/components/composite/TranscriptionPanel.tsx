import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { Cancel01Icon, Search01Icon, ArrowDown01Icon, ArrowUp01Icon, Download01Icon, Copy01Icon, FileTextIcon } from "../../utils/icons";
import { TranscriptLine, IconButton, Input } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { getParticipantColor, getParticipantThemeVariables } from "../../utils/colorGenerator";

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  isHost?: boolean;
  isLocalParticipant?: boolean;
}

export interface TranscriptionPanelProps {
  transcripts: TranscriptEntry[];
  isLive?: boolean;
  showSpeakerNames?: boolean;
  showTimestamps?: boolean;
  showConfidence?: boolean;
  searchable?: boolean;
  onExport?: (format: "txt" | "srt" | "vtt" | "json") => void;
  onCopyAll?: () => void;
  onClose?: () => void;
  position?: "right" | "bottom";
  variant?: "default" | "sidebar" | "mobile";
  localParticipantId?: string;
  participantColorSeed?: string;
  className?: string;
}

interface GroupedTranscript {
  speakerId: string;
  speaker: string;
  speakerColor: string;
  isHost?: boolean;
  isLocalParticipant?: boolean;
  entries: TranscriptEntry[];
}

function groupTranscriptsBySpeaker(transcripts: TranscriptEntry[]): GroupedTranscript[] {
  const groups: GroupedTranscript[] = [];

  for (const entry of transcripts) {
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup.speakerId !== entry.speakerId) {
      groups.push({
        speakerId: entry.speakerId,
        speaker: entry.speaker,
        speakerColor: getParticipantColor(entry.speaker || entry.speakerId).primary,
        isHost: entry.isHost,
        isLocalParticipant: entry.isLocalParticipant,
        entries: [entry],
      });
    } else {
      lastGroup.entries.push(entry);
    }
  }

  return groups;
}

interface SearchMatch {
  entryId: string;
  index: number;
}

function findSearchMatches(transcripts: TranscriptEntry[], query: string): SearchMatch[] {
  if (!query.trim()) return [];
  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const [i, entry] of transcripts.entries()) {
    if (entry.text.toLowerCase().includes(lowerQuery) || entry.speaker.toLowerCase().includes(lowerQuery)) {
      matches.push({ entryId: entry.id, index: i });
    }
  }

  return matches;
}

// Export dropdown component
function ExportDropdown({ onExport, onCopyAll }: { onExport?: (format: "txt" | "srt" | "vtt" | "json") => void; onCopyAll?: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleExport = (format: "txt" | "srt" | "vtt" | "json") => {
    onExport?.(format);
    setIsOpen(false);
  };

  const handleCopy = () => {
    onCopyAll?.();
    setIsOpen(false);
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors", "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground")} aria-expanded={isOpen} aria-haspopup="menu">
        <Download01Icon className="w-3.5 h-3.5" />
        Export
      </button>

      {isOpen && (
        <div className={cn("absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg shadow-lg border", "bg-popover border-border", "animate-in fade-in-0 zoom-in-95 duration-150")} role="menu">
          <div className="p-1">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Download</div>
            <button onClick={() => handleExport("txt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              TXT
            </button>
            <button onClick={() => handleExport("srt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              SRT
            </button>
            <button onClick={() => handleExport("vtt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              VTT
            </button>
            <button onClick={() => handleExport("json")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent text-left" role="menuitem">
              <span className="w-4 h-4 text-xs font-mono">{"{}"}</span>
              JSON
            </button>
          </div>
          <div className="border-t border-border p-1">
            <button onClick={handleCopy} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent text-left" role="menuitem">
              <Copy01Icon className="w-4 h-4" />
              Copy All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Empty state component
function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-primary/10">
        <FileTextIcon className="w-8 h-8 text-primary" />
      </div>
      <h3 className="text-sm font-medium text-foreground mb-1">No transcripts yet</h3>
      <p className="text-sm text-muted-foreground max-w-[200px]">Transcription will appear as people speak</p>
      <div className="flex gap-1 mt-4">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/30 chalk-animate-typing-dot" style={{ animationDelay: "0ms" }} />
        <span className="w-2 h-2 rounded-full bg-muted-foreground/30 chalk-animate-typing-dot" style={{ animationDelay: "150ms" }} />
        <span className="w-2 h-2 rounded-full bg-muted-foreground/30 chalk-animate-typing-dot" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
}

// Turn separator component
function TurnSeparator() {
  return (
    <div className="flex items-center gap-3 py-2" aria-hidden="true">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Speaker changed</span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

export const TranscriptionPanel = React.memo(
  ({ transcripts, isLive = true, showSpeakerNames = true, showTimestamps = true, showConfidence = true, searchable = true, onExport, onCopyAll, onClose, position = "right", variant = "default", localParticipantId, participantColorSeed, className }: TranscriptionPanelProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [searchQuery, setSearchQuery] = useState("");
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
    const [autoScroll, setAutoScroll] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed ?? localParticipantId), [participantColorSeed, localParticipantId]);

    // Search matches
    const searchMatches = useMemo(() => findSearchMatches(transcripts, searchQuery), [transcripts, searchQuery]);

    const currentMatch = searchMatches[currentMatchIndex];

    // Filter out interim transcripts that have been superseded by final ones
    // Keep only the latest transcript per speaker when interim is followed by final
    const filteredTranscripts = useMemo(() => {
      const result: TranscriptEntry[] = [];
      for (const [i, current] of transcripts.entries()) {
        const next = transcripts[i + 1];

        // Skip interim if next is final from same speaker (it supersedes)
        if (current.isInterim && next && !next.isInterim && next.speakerId === current.speakerId) {
          continue;
        }
        result.push(current);
      }
      return result;
    }, [transcripts]);

    // Group transcripts by speaker
    const groupedTranscripts = useMemo(() => groupTranscriptsBySpeaker(filteredTranscripts), [filteredTranscripts]);

    // Filter transcripts when searching
    const displayedGroups = useMemo(() => {
      if (!searchQuery.trim()) return groupedTranscripts;

      const matchedIds = new Set(searchMatches.map((m) => m.entryId));
      return groupedTranscripts
        .map((group) => ({
          ...group,
          entries: group.entries.filter((e) => matchedIds.has(e.id)),
        }))
        .filter((group) => group.entries.length > 0);
    }, [groupedTranscripts, searchQuery, searchMatches]);

    // Auto-scroll effect
    useEffect(() => {
      if (autoScroll && endRef.current && !searchQuery) {
        endRef.current.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
      }
    }, [transcripts, autoScroll, prefersReducedMotion, searchQuery]);

    // Scroll to current match
    useEffect(() => {
      if (currentMatch && containerRef.current) {
        const matchElement = containerRef.current.querySelector(`[data-transcript-match="true"]`);
        matchElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, [currentMatch, currentMatchIndex]);

    // Keyboard shortcuts
    useEffect(() => {
      function handleKeyDown(event: KeyboardEvent) {
        // Cmd/Ctrl + F to focus search
        if ((event.metaKey || event.ctrlKey) && event.key === "f" && searchable) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }

        // Escape to clear search
        if (event.key === "Escape" && searchQuery) {
          setSearchQuery("");
          setCurrentMatchIndex(0);
        }

        // Enter/Shift+Enter to navigate matches when search has focus
        if (document.activeElement === searchInputRef.current && searchMatches.length > 0) {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            setCurrentMatchIndex((i) => (i + 1) % searchMatches.length);
          } else if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            setCurrentMatchIndex((i) => (i - 1 + searchMatches.length) % searchMatches.length);
          }
        }
      }

      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [searchable, searchQuery, searchMatches.length]);

    const handleScroll = useCallback(() => {
      if (containerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
        setAutoScroll(isAtBottom);
      }
    }, []);

    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
      setCurrentMatchIndex(0);
    }, []);

    const handleClearSearch = useCallback(() => {
      setSearchQuery("");
      setCurrentMatchIndex(0);
      searchInputRef.current?.focus();
    }, []);

    const navigateMatch = useCallback(
      (direction: "prev" | "next") => {
        if (searchMatches.length === 0) return;
        setCurrentMatchIndex((i) => {
          if (direction === "next") {
            return (i + 1) % searchMatches.length;
          }
          return (i - 1 + searchMatches.length) % searchMatches.length;
        });
      },
      [searchMatches.length],
    );

    const handleCopyAll = useCallback(() => {
      if (onCopyAll) {
        onCopyAll();
      } else {
        const text = transcripts.map((t) => `[${t.timestamp.toLocaleTimeString()}] ${t.speaker}: ${t.text}`).join("\n");
        navigator.clipboard.writeText(text);
      }
    }, [transcripts, onCopyAll]);

    // Render transcript content
    const renderTranscriptContent = () => {
      if (transcripts.length === 0) {
        return <EmptyState />;
      }

      return (
        <>
          {displayedGroups.map((group, groupIndex) => (
            <React.Fragment key={`${group.speakerId}-${groupIndex}`}>
              {groupIndex > 0 && <TurnSeparator />}
              {group.entries.map((entry, entryIndex) => (
                <TranscriptLine
                  key={entry.id}
                  speaker={entry.speaker}
                  speakerId={entry.speakerId}
                  text={entry.text}
                  timestamp={entry.timestamp}
                  isInterim={entry.isInterim}
                  confidence={showConfidence ? entry.confidence : undefined}
                  showTimestamp={showTimestamps}
                  showSpeaker={showSpeakerNames}
                  speakerColor={group.speakerColor}
                  isHost={entry.isHost}
                  isLocalParticipant={entry.isLocalParticipant || entry.speakerId === localParticipantId}
                  showAvatar={entryIndex === 0}
                  showHeader={entryIndex === 0}
                  searchHighlight={searchQuery || undefined}
                  isCurrentMatch={currentMatch?.entryId === entry.id}
                />
              ))}
            </React.Fragment>
          ))}
          <div ref={endRef} />
        </>
      );
    };

    // Render search bar - always full width input
    const renderSearchBar = () => {
      if (!searchable) return null;

      return (
        <div className="relative flex-1">
          <Search01Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search transcript..."
            value={searchQuery}
            onChange={handleSearchChange}
            className={cn("w-full h-8 pl-8 pr-8 text-sm rounded-lg border bg-background/50", "focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary", "placeholder:text-muted-foreground")}
          />
          {searchQuery && (
            <button onClick={handleClearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <Cancel01Icon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      );
    };

    // Render search navigation (only when there are matches)
    const renderSearchNav = () => {
      if (!searchQuery || searchMatches.length === 0) return null;

      return (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">
            {currentMatchIndex + 1}/{searchMatches.length}
          </span>
          <button onClick={() => navigateMatch("prev")} className="p-1 rounded hover:bg-muted hover:text-foreground" aria-label="Previous match">
            <ArrowUp01Icon className="w-3 h-3" />
          </button>
          <button onClick={() => navigateMatch("next")} className="p-1 rounded hover:bg-muted hover:text-foreground" aria-label="Next match">
            <ArrowDown01Icon className="w-3 h-3" />
          </button>
        </div>
      );
    };

    // New content indicator
    const renderNewContentIndicator = () => {
      if (autoScroll || searchQuery) return null;

      return (
        <div className="sticky bottom-0 flex justify-center pb-2 pointer-events-none">
          <button
            onClick={() => {
              setAutoScroll(true);
              endRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
            }}
            className={cn("px-3 py-1.5 rounded-full text-xs font-medium shadow-lg flex items-center gap-1.5 pointer-events-auto transition-all", "bg-primary text-primary-foreground", "hover:bg-primary/90")}
          >
            <ArrowDown01Icon className="w-3.5 h-3.5" />
            New content
          </button>
        </div>
      );
    };

    // Mobile variant
    if (variant === "mobile") {
      return (
        <div className={cn("flex flex-col h-full w-full overflow-hidden font-sans relative", "bg-background", className)} data-tour="transcription-panel" role="complementary" aria-label="Live transcription" style={themeVariables as React.CSSProperties}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              {onClose && (
                <button onClick={onClose} className="p-1 -ml-1 text-muted-foreground hover:text-foreground" aria-label="Back">
                  <Cancel01Icon className="w-5 h-5" />
                </button>
              )}
              <h2 className="text-base font-semibold text-foreground">Transcript</h2>
            </div>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/15 text-primary">
                <span className="w-1.5 h-1.5 rounded-full bg-primary chalk-animate-pulse" />
                Live
              </span>
            )}
          </div>

          {/* Search */}
          {searchable && (
            <div className="px-4 py-2 border-b border-border">
              <Input placeholder="Search transcript..." value={searchQuery} onChange={handleSearchChange} icon={<Search01Icon className="w-4 h-4" />} iconPosition="left" className="w-full" size="sm" />
            </div>
          )}

          {/* Content */}
          <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-1 relative" onScroll={handleScroll}>
            {renderTranscriptContent()}
            {renderNewContentIndicator()}
          </div>
        </div>
      );
    }

    // Sidebar variant
    if (variant === "sidebar") {
      return (
        <div
          className={cn("flex flex-col h-full w-full overflow-hidden font-sans relative", "bg-transparent", !prefersReducedMotion && "animate-in slide-in-from-right duration-300", className)}
          data-tour="transcription-panel"
          role="complementary"
          aria-label="Live transcription"
          style={themeVariables as React.CSSProperties}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold tracking-tight text-card-foreground">Transcript</h2>
              {isLive && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/15 text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary chalk-animate-pulse" />
                  Live
                </span>
              )}
            </div>
            {onClose && (
              <button onClick={onClose} className="p-1 transition-colors text-muted-foreground hover:text-foreground" aria-label="Close">
                <Cancel01Icon className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Controls bar */}
          <div className="flex items-center gap-2 px-6 pb-4">
            {renderSearchBar()}
            {renderSearchNav()}
            {(onExport || onCopyAll) && <ExportDropdown onExport={onExport} onCopyAll={handleCopyAll} />}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 pb-6 flex flex-col">
            <div ref={containerRef} className={cn("rounded-2xl overflow-hidden p-4 space-y-1 relative min-h-[300px] flex-1", "bg-muted/30 backdrop-blur-sm border border-border/30")} onScroll={handleScroll}>
              {renderTranscriptContent()}
              {renderNewContentIndicator()}
            </div>
          </div>
        </div>
      );
    }

    // Default variant
    return (
      <div
        className={cn(
          "flex flex-col shadow-xl",
          "bg-card",
          "border-border/50",
          position === "right" ? cn("h-full w-80 border-l", !prefersReducedMotion && "animate-in slide-in-from-right duration-300") : cn("w-full h-64 border-t", !prefersReducedMotion && "animate-in slide-in-from-bottom duration-300"),
          className,
        )}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
        style={themeVariables as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-card-foreground">Transcript</h2>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/15 text-primary">
                <span className="w-1 h-1 rounded-full bg-primary chalk-animate-pulse" />
                Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {(onExport || onCopyAll) && <ExportDropdown onExport={onExport} onCopyAll={handleCopyAll} />}
            {onClose && <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close transcription" />}
          </div>
        </div>

        {/* Search and export bar */}
        <div className="flex items-center gap-2 p-3 pb-0">
          {searchable && renderSearchBar()}
          {renderSearchNav()}
          {(onExport || onCopyAll) && <ExportDropdown onExport={onExport} onCopyAll={handleCopyAll} />}
        </div>

        {/* Content */}
        <div ref={containerRef} className="flex-1 overflow-y-auto p-3 space-y-1 relative" onScroll={handleScroll}>
          {renderTranscriptContent()}
          {renderNewContentIndicator()}
        </div>
      </div>
    );
  },
);

TranscriptionPanel.displayName = "TranscriptionPanel";
