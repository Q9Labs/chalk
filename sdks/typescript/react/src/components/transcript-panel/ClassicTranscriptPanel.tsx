import React from "react";
import { IconButton, Input } from "@q9labsai/chalk-ui";
import { Cancel01Icon, Search01Icon, ArrowDown01Icon, ArrowUp01Icon, Download01Icon, Copy01Icon, FileTextIcon } from "../../utils/icons";
import { TranscriptLine } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { useConnectedTranscriptPanelBehavior, useTranscriptExportMenu, useTranscriptPanelBehavior, type TranscriptExportFormat, type TranscriptPanelProps, type TranscriptPanelSurfaceProps } from "./transcript-panel-behavior";

// Export dropdown component
function ExportDropdown({ onExport, onCopyAll }: { onExport?: (format: TranscriptExportFormat) => void; onCopyAll?: () => void }) {
  const { isOpen, menuRef: dropdownRef, toggleMenu, selectExport: handleExport, selectCopy: handleCopy } = useTranscriptExportMenu(onExport, onCopyAll);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors", "bg-[var(--chalk-stage)] text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Download01Icon className="w-3.5 h-3.5" />
        Export
      </button>

      {isOpen && (
        <div className={cn("absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg shadow-lg border", "bg-[var(--chalk-surface)] border-[var(--chalk-line)]", "animate-in fade-in-0 zoom-in-95 duration-150")} role="menu">
          <div className="p-1">
            <div className="px-2 py-1.5 text-xs font-medium text-[var(--chalk-muted-text)]">Download</div>
            <button type="button" onClick={() => handleExport("txt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-[var(--chalk-stage)] text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              TXT
            </button>
            <button type="button" onClick={() => handleExport("srt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-[var(--chalk-stage)] text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              SRT
            </button>
            <button type="button" onClick={() => handleExport("vtt")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-[var(--chalk-stage)] text-left" role="menuitem">
              <FileTextIcon className="w-4 h-4" />
              VTT
            </button>
            <button type="button" onClick={() => handleExport("json")} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-[var(--chalk-stage)] text-left" role="menuitem">
              <span className="w-4 h-4 text-xs font-mono">{"{}"}</span>
              JSON
            </button>
          </div>
          <div className="border-t border-[var(--chalk-line)] p-1">
            <button type="button" onClick={handleCopy} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-[var(--chalk-stage)] text-left" role="menuitem">
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
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-[var(--chalk-accent)]">
        <FileTextIcon className="w-8 h-8 text-[var(--chalk-accent)]" />
      </div>
      <h3 className="text-sm font-medium text-[var(--chalk-text)] mb-1">No transcripts yet</h3>
      <p className="text-sm text-[var(--chalk-muted-text)] max-w-[200px]">Transcription will appear as people speak</p>
      <div className="flex gap-1 mt-4">
        <span className="w-2 h-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "0ms" }} />
        <span className="w-2 h-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "150ms" }} />
        <span className="w-2 h-2 rounded-full bg-[var(--chalk-muted-text)] chalk-animate-typing-dot" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
}

// Turn separator component
function TurnSeparator() {
  return (
    <div className="flex items-center gap-3 py-2" aria-hidden="true">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[10px] text-[var(--chalk-muted-text)] uppercase tracking-wider">Speaker changed</span>
      <div className="flex-1 h-px bg-border/50" />
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
          <Search01Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--chalk-muted-text)]" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search transcript..."
            value={searchQuery}
            onChange={handleSearchChange}
            className={cn("w-full h-8 pl-8 pr-8 text-sm rounded-lg border bg-[var(--chalk-canvas)]", "focus:outline-none focus:ring-2 focus:ring-[var(--chalk-focus)] focus:border-[var(--chalk-accent)]", "placeholder:text-[var(--chalk-muted-text)]")}
          />
          {searchQuery && (
            <button type="button" onClick={handleClearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Clear search">
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
        <div className="flex items-center gap-1 text-xs text-[var(--chalk-muted-text)]">
          <span className="whitespace-nowrap">
            {currentMatchIndex + 1}/{searchMatches.length}
          </span>
          <button type="button" onClick={() => navigateMatch("prev")} className="p-1 rounded hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]" aria-label="Previous match">
            <ArrowUp01Icon className="w-3 h-3" />
          </button>
          <button type="button" onClick={() => navigateMatch("next")} className="p-1 rounded hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]" aria-label="Next match">
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
          <button type="button" onClick={scrollToLatest} className={cn("px-3 py-1.5 rounded-full text-xs font-medium shadow-lg flex items-center gap-1.5 pointer-events-auto transition-all", "bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)]", "hover:bg-[var(--chalk-accent)]")}>
            <ArrowDown01Icon className="w-3.5 h-3.5" />
            New content
          </button>
        </div>
      );
    };

    // Mobile variant
    if (variant === "mobile") {
      return (
        <div className={cn("flex flex-col h-full w-full overflow-hidden font-sans relative", "bg-[var(--chalk-canvas)]", className)} data-tour="transcription-panel" role="complementary" aria-label="Live transcription" style={themeVariables as React.CSSProperties}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--chalk-line)]">
            <div className="flex items-center gap-2">
              {onClose && (
                <button type="button" onClick={onClose} className="p-1 -ml-1 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Back">
                  <Cancel01Icon className="w-5 h-5" />
                </button>
              )}
              <h2 className="text-base font-semibold text-[var(--chalk-text)]">Transcript</h2>
            </div>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--chalk-stage)] text-[var(--chalk-accent)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
                Live
              </span>
            )}
          </div>

          {/* Search */}
          {searchable && (
            <div className="px-4 py-2 border-b border-[var(--chalk-line)]">
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
        <div className={cn("flex flex-col h-full w-full overflow-hidden font-sans relative", "bg-transparent", className)} data-tour="transcription-panel" role="complementary" aria-label="Live transcription" style={themeVariables as React.CSSProperties}>
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold tracking-tight text-[var(--chalk-text)]">Transcript</h2>
              {isLive && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--chalk-stage)] text-[var(--chalk-accent)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
                  Live
                </span>
              )}
            </div>
            {onClose && (
              <button type="button" onClick={onClose} className="p-1 transition-colors text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Close">
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
          <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
            <div ref={containerRef} className={cn("relative min-h-0 flex-1 space-y-1 overflow-y-auto rounded-2xl p-4", "bg-[var(--chalk-stage)] border border-[var(--chalk-line)]")} onScroll={handleScroll}>
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
          "bg-[var(--chalk-surface)]",
          "border-[var(--chalk-line)]",
          position === "right" ? cn("h-full w-80 border-l", !prefersReducedMotion && "animate-in slide-in-from-right duration-300") : cn("w-full h-64 border-t", !prefersReducedMotion && "animate-in slide-in-from-bottom duration-300"),
          className,
        )}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
        style={themeVariables as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-[var(--chalk-line)]">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--chalk-text)]">Transcript</h2>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--chalk-stage)] text-[var(--chalk-accent)]">
                <span className="w-1 h-1 rounded-full bg-[var(--chalk-accent)] chalk-animate-pulse" />
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

export const ClassicTranscriptPanel = React.memo((props: TranscriptPanelProps): React.JSX.Element => {
  const surfaceProps = useConnectedTranscriptPanelBehavior(props);
  return <TranscriptPanelSurface {...surfaceProps} />;
});

ClassicTranscriptPanel.displayName = "TranscriptPanel";
