import React from "react";
import { Cancel01Icon, Search01Icon, ArrowDown01Icon, ArrowUp01Icon, Download01Icon, Copy01Icon, FileTextIcon } from "../../utils/icons";
import { TranscriptLine } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkBadge, ChalkButton, ChalkChrome, ChalkDivider, ChalkEmptyState, ChalkIconButton, ChalkInput, ChalkMenu, ChalkMenuItem, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicTranscriptPanel } from "./ClassicTranscriptPanel";
import { useConnectedTranscriptPanelBehavior, useTranscriptExportMenu, useTranscriptPanelBehavior, type TranscriptExportFormat, type TranscriptPanelProps, type TranscriptPanelSurfaceProps } from "./transcript-panel-behavior";

export type { TranscriptEntry, TranscriptPanelProps } from "./transcript-panel-behavior";

// Export dropdown component
function ExportDropdown({ onExport, onCopyAll }: { onExport?: (format: TranscriptExportFormat) => void; onCopyAll?: () => void }) {
  const { isOpen, menuRef: dropdownRef, toggleMenu, selectExport: handleExport, selectCopy: handleCopy } = useTranscriptExportMenu(onExport, onCopyAll);

  return (
    <div ref={dropdownRef} className="relative">
      <ChalkButton type="button" variant="ghost" onClick={toggleMenu} className={cn("min-h-8 gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]")} aria-expanded={isOpen} aria-haspopup="menu">
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
    const {
      searchQuery,
      themeVariables,
      currentMatchIndex,
      autoScroll,
      containerRef,
      endRef,
      searchInputRef,
      searchMatches,
      currentMatch,
      displayedGroups,
      onScroll: handleScroll,
      onSearchChange: handleSearchChange,
      clearSearch: handleClearSearch,
      navigateMatch,
      copyAll: handleCopyAll,
      scrollToLatest,
    } = useTranscriptPanelBehavior({ transcripts, searchable, prefersReducedMotion, onCopyAll, participantColorSeed, localParticipantId, participantGradientPreference });

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
          <ChalkButton type="button" onClick={scrollToLatest} variant="solid" tone="accent" className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg">
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
        <ChalkPanel className={cn("relative h-full w-full overflow-hidden bg-transparent p-0 font-sans", className)} contentClassName="flex h-full min-h-0 flex-col" data-tour="transcription-panel" role="complementary" aria-label="Live transcription" style={themeVariables as React.CSSProperties}>
          <div className="flex h-full min-h-0 w-full flex-col">
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
            <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
              <ChalkPanel ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto rounded-2xl bg-[var(--chalk-stage)] p-4" contentClassName="min-h-full" onScroll={handleScroll}>
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
  const surfaceProps = useConnectedTranscriptPanelBehavior(props);
  return <TranscriptPanelSurface {...surfaceProps} />;
});

export const TranscriptPanel = React.memo((props: TranscriptPanelProps): React.JSX.Element => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicTranscriptPanel {...props} /> : <ChalkTranscriptPanel {...props} />;
});

TranscriptPanel.displayName = "TranscriptPanel";
