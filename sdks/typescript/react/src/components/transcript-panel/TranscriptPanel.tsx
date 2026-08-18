import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useConnection, useSelf } from "../../bindings/hooks";
import { Cancel01Icon, Search01Icon, ArrowDown01Icon, ArrowUp01Icon, Download01Icon, Copy01Icon, FileTextIcon } from "../../utils/icons";
import { TranscriptLine } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantColor, getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ChalkBadge, ChalkButton, ChalkChrome, ChalkDivider, ChalkEmptyState, ChalkIconButton, ChalkInput, ChalkMenu, ChalkMenuItem, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicTranscriptPanel } from "./ClassicTranscriptPanel";

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  isLocalParticipant?: boolean;
}

export interface TranscriptPanelProps {
  showSpeakerNames?: boolean;
  showTimestamps?: boolean;
  showConfidence?: boolean;
  searchable?: boolean;
  onExport?: (format: "txt" | "srt" | "vtt" | "json") => void;
  onCopyAll?: () => void;
  onClose?: () => void;
  position?: "right" | "bottom";
  variant?: "default" | "sidebar" | "mobile";
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

interface TranscriptPanelSurfaceProps extends TranscriptPanelProps {
  readonly transcripts: TranscriptEntry[];
  readonly isLive?: boolean;
  readonly localParticipantId?: string;
}

interface GroupedTranscript {
  speakerId: string;
  speaker: string;
  speakerColor: string;
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
      <ChalkButton type="button" variant="ghost" onClick={() => setIsOpen(!isOpen)} className={cn("min-h-8 gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]")} aria-expanded={isOpen} aria-haspopup="menu">
        <Download01Icon className="w-3.5 h-3.5" />
        Export
      </ChalkButton>

      {isOpen && (
        <ChalkMenu className={cn("absolute right-0 top-full z-50 min-w-[140px] rounded-lg p-1 shadow-lg", "bg-[var(--chalk-surface)]", "animate-in fade-in-0 zoom-in-95 duration-150")}>
          <div className="px-2 py-1.5 text-xs font-medium text-[var(--chalk-muted-text)]">Download</div>
          <ExportMenuItem onSelect={() => handleExport("txt")}>
            <FileTextIcon className="w-4 h-4" />
            TXT
          </ExportMenuItem>
          <ExportMenuItem onSelect={() => handleExport("srt")}>
            <FileTextIcon className="w-4 h-4" />
            SRT
          </ExportMenuItem>
          <ExportMenuItem onSelect={() => handleExport("vtt")}>
            <FileTextIcon className="w-4 h-4" />
            VTT
          </ExportMenuItem>
          <ExportMenuItem onSelect={() => handleExport("json")}>
            <span className="w-4 h-4 text-xs font-mono">{"{}"}</span>
            JSON
          </ExportMenuItem>
          <ChalkDivider className="my-1 h-3" />
          <div className="p-1">
            <ExportMenuItem onSelect={handleCopy}>
              <Copy01Icon className="w-4 h-4" />
              Copy All
            </ExportMenuItem>
          </div>
        </ChalkMenu>
      )}
    </div>
  );
}

function ExportMenuItem({ children, onSelect }: { readonly children: React.ReactNode; readonly onSelect: () => void }): React.JSX.Element {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <ChalkMenuItem onClick={onSelect} onKeyDown={handleKeyDown} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm">
      {children}
    </ChalkMenuItem>
  );
}

// Empty state component
function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-4">
      <ChalkEmptyState className="w-full max-w-sm" title="No transcripts yet" description="Transcription will appear as people speak">
        <div className="flex flex-col items-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--chalk-accent)]">
            <FileTextIcon className="w-8 h-8 text-[var(--chalk-accent)]" />
          </div>
          <div className="mt-4 flex gap-1">
            <span className="h-2 w-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "0ms" }} />
            <span className="h-2 w-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "150ms" }} />
            <span className="h-2 w-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </ChalkEmptyState>
    </div>
  );
}

// Turn separator component
function TurnSeparator() {
  return (
    <div className="flex items-center gap-3 py-2" aria-hidden="true">
      <ChalkDivider className="m-0 h-3 flex-1" />
      <span className="text-[10px] text-[var(--chalk-muted-text)] uppercase tracking-wider">Speaker changed</span>
      <ChalkDivider className="m-0 h-3 flex-1" />
    </div>
  );
}

const TranscriptPanelSurface = React.memo(
  ({
    transcripts,
    isLive = true,
    showSpeakerNames = true,
    showTimestamps = true,
    showConfidence = true,
    searchable = true,
    onExport,
    onCopyAll,
    onClose,
    position = "right",
    variant = "default",
    localParticipantId,
    participantColorSeed,
    participantGradientPreference,
    className,
  }: TranscriptPanelSurfaceProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [searchQuery, setSearchQuery] = useState("");
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
    const [autoScroll, setAutoScroll] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed ?? localParticipantId, participantGradientPreference), [participantColorSeed, participantGradientPreference, localParticipantId]);

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
          <Search01Icon className="pointer-events-none absolute left-2.5 top-1/2 z-[2] h-3.5 w-3.5 -translate-y-1/2 text-[var(--chalk-muted-text)]" />
          <ChalkInput ref={searchInputRef} type="text" placeholder="Search transcript..." value={searchQuery} onChange={handleSearchChange} wrapperClassName="w-full" className="h-8 min-h-8 w-full rounded-lg bg-[var(--chalk-canvas)] pl-8 pr-8 text-sm placeholder:text-[var(--chalk-muted-text)]" />
          {searchQuery && (
            <ChalkIconButton type="button" size="sm" onClick={handleClearSearch} className="absolute right-1 top-1/2 z-[2] size-7 -translate-y-1/2 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Clear search">
              <Cancel01Icon className="w-3.5 h-3.5" />
            </ChalkIconButton>
          )}
        </div>
      );
    };

    // Render search navigation (only when there are matches)
    const renderSearchNav = () => {
      if (!searchQuery || searchMatches.length === 0) return null;

      return (
        <div className="flex items-center gap-1 text-xs text-[var(--chalk-muted-text)]">
          <span className="whitespace-nowrap">
            {currentMatchIndex + 1}/{searchMatches.length}
          </span>
          <ChalkIconButton type="button" size="sm" onClick={() => navigateMatch("prev")} className="size-7 rounded" aria-label="Previous match">
            <ArrowUp01Icon className="w-3 h-3" />
          </ChalkIconButton>
          <ChalkIconButton type="button" size="sm" onClick={() => navigateMatch("next")} className="size-7 rounded" aria-label="Next match">
            <ArrowDown01Icon className="w-3 h-3" />
          </ChalkIconButton>
        </div>
      );
    };

    // New content indicator
    const renderNewContentIndicator = () => {
      if (autoScroll || searchQuery) return null;

      return (
        <div className="sticky bottom-0 flex justify-center pb-2 pointer-events-none">
          <ChalkButton
            type="button"
            onClick={() => {
              setAutoScroll(true);
              endRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
            }}
            variant="solid"
            tone="accent"
            className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg"
          >
            <ArrowDown01Icon className="w-3.5 h-3.5" />
            New content
          </ChalkButton>
        </div>
      );
    };

    // Mobile variant
    if (variant === "mobile") {
      return (
        <ChalkPanel className={cn("relative h-full w-full overflow-hidden bg-[var(--chalk-canvas)] p-0 font-sans", className)} data-tour="transcription-panel" role="complementary" aria-label="Live transcription" style={themeVariables as React.CSSProperties}>
          <div className="flex h-full w-full flex-col">
            {/* Header */}
            <header className="group relative flex items-center justify-between px-4 py-3">
              <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface, var(--chalk-canvas))" part="transcript-header" />
              <div className="flex items-center gap-2">
                {onClose && (
                  <ChalkIconButton type="button" size="sm" onClick={onClose} className="-ml-1 size-8 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Back">
                    <Cancel01Icon className="w-5 h-5" />
                  </ChalkIconButton>
                )}
                <h2 className="relative z-[1] text-base font-semibold text-[var(--chalk-text)]">Transcript</h2>
              </div>
              {isLive && (
                <ChalkBadge className="relative z-[1] inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-[var(--chalk-accent)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
                  Live
                </ChalkBadge>
              )}
            </header>

            {/* Search */}
            {searchable && <div className="px-4 py-2">{renderSearchBar()}</div>}

            {/* Content */}
            <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-1 relative" onScroll={handleScroll}>
              {renderTranscriptContent()}
              {renderNewContentIndicator()}
            </div>
          </div>
        </ChalkPanel>
      );
    }

    // Sidebar variant
    if (variant === "sidebar") {
      return (
        <ChalkPanel
          className={cn("relative h-full w-full overflow-hidden bg-transparent p-0 font-sans", !prefersReducedMotion && "animate-in slide-in-from-right duration-300", className)}
          data-tour="transcription-panel"
          role="complementary"
          aria-label="Live transcription"
          style={themeVariables as React.CSSProperties}
        >
          <div className="flex h-full w-full flex-col">
            {/* Header */}
            <header className="group relative flex items-center justify-between px-6 pb-4 pt-6">
              <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface, var(--chalk-canvas))" part="transcript-header" />
              <div className="flex items-center gap-3">
                <h2 className="relative z-[1] text-xl font-bold tracking-tight text-[var(--chalk-text)]">Transcript</h2>
                {isLive && (
                  <ChalkBadge className="relative z-[1] inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-[var(--chalk-accent)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
                    Live
                  </ChalkBadge>
                )}
              </div>
              {onClose && (
                <ChalkIconButton type="button" size="sm" onClick={onClose} className="relative z-[1] text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Close">
                  <Cancel01Icon className="w-5 h-5" />
                </ChalkIconButton>
              )}
            </header>

            {/* Controls bar */}
            <div className="flex items-center gap-2 px-6 pb-4">
              {renderSearchBar()}
              {renderSearchNav()}
              {(onExport || onCopyAll) && <ExportDropdown onExport={onExport} onCopyAll={handleCopyAll} />}
            </div>

            {/* Content */}
            <div className="flex flex-1 flex-col overflow-y-auto px-6 pb-6">
              <ChalkPanel ref={containerRef} className="relative min-h-[300px] flex-1 overflow-y-auto rounded-2xl bg-[var(--chalk-stage)] p-4" onScroll={handleScroll}>
                {renderTranscriptContent()}
                {renderNewContentIndicator()}
              </ChalkPanel>
            </div>
          </div>
        </ChalkPanel>
      );
    }

    // Default variant
    return (
      <ChalkPanel
        className={cn("relative flex shadow-xl p-0", "bg-[var(--chalk-surface)]", position === "right" ? cn("h-full w-80", !prefersReducedMotion && "animate-in slide-in-from-right duration-300") : cn("h-64 w-full", !prefersReducedMotion && "animate-in slide-in-from-bottom duration-300"), className)}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
        style={themeVariables as React.CSSProperties}
      >
        <div className="flex h-full w-full flex-col">
          {/* Header */}
          <header className="group relative flex items-center justify-between p-3">
            <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface)" part="transcript-header" />
            <div className="flex items-center gap-2">
              <h2 className="relative z-[1] text-sm font-semibold text-[var(--chalk-text)]">Transcript</h2>
              {isLive && (
                <ChalkBadge className="relative z-[1] inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--chalk-accent)]">
                  <span className="w-1 h-1 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
                  Live
                </ChalkBadge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {(onExport || onCopyAll) && <ExportDropdown onExport={onExport} onCopyAll={handleCopyAll} />}
              {onClose && (
                <ChalkIconButton size="sm" onClick={onClose} aria-label="Close transcription">
                  <Cancel01Icon className="w-4 h-4" />
                </ChalkIconButton>
              )}
            </div>
          </header>

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
      </ChalkPanel>
    );
  },
);

const ChalkTranscriptPanel = React.memo((props: TranscriptPanelProps): React.JSX.Element => {
  const connection = useConnection();
  const self = useSelf();

  return <TranscriptPanelSurface {...props} transcripts={[]} isLive={connection.status === "live" || connection.status === "reconnecting"} localParticipantId={self.participantId ?? undefined} participantColorSeed={props.participantColorSeed ?? self.displayName ?? undefined} />;
});

export const TranscriptPanel = React.memo((props: TranscriptPanelProps): React.JSX.Element => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicTranscriptPanel {...props} /> : <ChalkTranscriptPanel {...props} />;
});

TranscriptPanel.displayName = "TranscriptPanel";
