import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Cancel01Icon, Search01Icon, ArrowDown01Icon, FileTextIcon } from '../../utils/icons';
import {
  TranscriptLine,
  IconButton,
  Input,
  StatusBadge,
  Select
} from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
}

export interface TranscriptionPanelProps {
  transcripts: TranscriptEntry[];
  isLive?: boolean;
  showSpeakerNames?: boolean;
  showTimestamps?: boolean;
  showConfidence?: boolean;
  searchable?: boolean;
  onExport?: (format: 'txt' | 'srt' | 'vtt') => void;
  onClose?: () => void;
  position?: 'right' | 'bottom';
  variant?: 'default' | 'sidebar' | 'mobile';
  className?: string;
}

// Colors that work well on both light and dark backgrounds
const SPEAKER_COLORS = [
  '#1bb6a6', // teal (brand)
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#F59E0B', // amber
  '#10B981', // emerald
];

export const TranscriptionPanel = React.memo(({
  transcripts,
  isLive = true,
  showSpeakerNames = true,
  showTimestamps = true,
  showConfidence = true,
  searchable = true,
  onExport,
  onClose,
  position = 'right',
  variant = 'default',
  className
}: TranscriptionPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const filteredTranscripts = useMemo(() => {
    if (!searchQuery) return transcripts;
    const lowerQuery = searchQuery.toLowerCase();
    return transcripts.filter(t => 
      t.text.toLowerCase().includes(lowerQuery) || 
      t.speaker.toLowerCase().includes(lowerQuery)
    );
  }, [transcripts, searchQuery]);


  useEffect(() => {
    if (autoScroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts, autoScroll]);

  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  const handleExportChange = (e: { target: { value: string } }) => {
    if (onExport && e.target.value) {
      onExport(e.target.value as 'txt' | 'srt' | 'vtt');
      e.target.value = '';
    }
  };

  const getSpeakerColor = (speakerId: string) => {
    let hash = 0;
    for (let i = 0; i < speakerId.length; i++) {
      hash = speakerId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
  };

  if (variant === 'mobile') {
    return (
      <div
        className={cn(
          "flex flex-col h-full w-full overflow-hidden font-sans relative",
          "bg-card",
          className
        )}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
      >
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {searchable && (
            <div className="mb-4">
              <Input
                placeholder="Search transcript..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                icon={<Search01Icon className="w-4 h-4" />}
                iconPosition="left"
                className="w-full"
                size="sm"
              />
            </div>
          )}

          <div
            ref={containerRef}
            className={cn(
              "rounded-2xl overflow-hidden p-4 space-y-3 relative min-h-[200px]",
              "bg-muted/50 backdrop-blur-xl"
            )}
            onScroll={handleScroll}
          >
            {isLive && (
              <div className="flex items-center gap-2 mb-3">
                <StatusBadge status="transcribing" size="sm" pulse />
                <span className="text-xs text-muted-foreground">Live transcription</span>
              </div>
            )}

            {filteredTranscripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-8 text-muted-foreground">
                <p className="text-sm">Transcription will appear here</p>
              </div>
            ) : (
              filteredTranscripts.map((entry) => (
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
                  speakerColor={getSpeakerColor(entry.speakerId)}
                />
              ))
            )}
            <div ref={endRef} />

            {!autoScroll && (
              <div className="sticky bottom-0 flex justify-center pb-2 pointer-events-none">
                <button
                  onClick={() => {
                    setAutoScroll(true);
                    endRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs shadow-lg flex items-center gap-1 pointer-events-auto transition-colors",
                    "bg-secondary text-foreground",
                    "hover:bg-accent"
                  )}
                >
                  <ArrowDown01Icon className="w-3 h-3" />
                  New content
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'sidebar') {
    return (
      <div
        className={cn(
          "flex flex-col h-full w-full overflow-hidden font-sans relative",
          "bg-transparent",
          !prefersReducedMotion && "animate-in slide-in-from-right duration-300",
          className
        )}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-5">
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold tracking-tight text-card-foreground">Transcription</h2>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[#1bb6a6]/15 text-[#1bb6a6]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#1bb6a6] animate-pulse" />
                Live
              </span>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <Cancel01Icon className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {searchable && (
            <div className="mb-4">
              <Input
                placeholder="Search transcript..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                icon={<Search01Icon className="w-4 h-4" />}
                iconPosition="left"
                className="w-full"
                size="sm"
              />
            </div>
          )}

          <div
            ref={containerRef}
            className={cn(
              "rounded-2xl overflow-hidden p-4 space-y-3 relative min-h-[300px]",
              "bg-muted/30 backdrop-blur-sm border border-border/30"
            )}
            onScroll={handleScroll}
          >
            {filteredTranscripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12">
                <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3 bg-[#1bb6a6]/10 text-[#1bb6a6]">
                  <FileTextIcon className="w-6 h-6" />
                </div>
                <p className="text-sm text-muted-foreground">Transcription will appear here</p>
              </div>
            ) : (
              filteredTranscripts.map((entry) => (
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
                  speakerColor={getSpeakerColor(entry.speakerId)}
                />
              ))
            )}
            <div ref={endRef} />

            {!autoScroll && (
              <div className="sticky bottom-0 flex justify-center pb-2 pointer-events-none">
                <button
                  onClick={() => {
                    setAutoScroll(true);
                    endRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs shadow-lg flex items-center gap-1 pointer-events-auto transition-colors",
                    "bg-secondary text-foreground",
                    "hover:bg-accent"
                  )}
                >
                  <ArrowDown01Icon className="w-3 h-3" />
                  New content
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col shadow-xl",
        "bg-card",
        "border-border/50",
        position === 'right'
          ? cn("h-full w-80 border-l", !prefersReducedMotion && "animate-in slide-in-from-right duration-300")
          : cn("w-full h-64 border-t", !prefersReducedMotion && "animate-in slide-in-from-bottom duration-300"),
        className
      )}
      data-tour="transcription-panel"
      role="complementary"
      aria-label="Live transcription"
    >
      <div className="flex items-center justify-between p-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-card-foreground">Transcription</h2>
          {isLive && <StatusBadge status="transcribing" size="sm" pulse />}
        </div>
        <div className="flex items-center gap-1">
          {onExport && (
            <div className="w-24">
              <Select
                options={[
                  { label: 'TXT', value: 'txt' },
                  { label: 'SRT', value: 'srt' },
                  { label: 'VTT', value: 'vtt' },
                ]}
                placeholder="Export"
                size="sm"
                onChange={handleExportChange}
                className="min-w-0"
              />
            </div>
          )}
          {onClose && (
            <IconButton
              icon={<Cancel01Icon className="w-4 h-4" />}
              size="sm"
              variant="ghost"
              onClick={onClose}
              aria-label="Close transcription"
            />
          )}
        </div>
      </div>

      {searchable && (
        <div className="p-4 pb-2">
          <Input
            placeholder="Search transcript..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            icon={<Search01Icon className="w-4 h-4" />}
            iconPosition="left"
            className="w-full"
            size="sm"
          />
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 space-y-1 relative"
        onScroll={handleScroll}
      >
        {filteredTranscripts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center opacity-60 text-muted-foreground">
            <p className="text-sm">Transcription will appear here</p>
          </div>
        ) : (
          filteredTranscripts.map((entry) => (
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
              speakerColor={getSpeakerColor(entry.speakerId)}
            />
          ))
        )}
        <div ref={endRef} />

        {!autoScroll && (
          <div className="sticky bottom-0 flex justify-center pb-2 pointer-events-none">
            <button
              onClick={() => {
                setAutoScroll(true);
                endRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={cn(
                "px-3 py-1 rounded-full text-xs shadow-lg flex items-center gap-1 pointer-events-auto transition-colors",
                "bg-primary text-primary-foreground",
                "hover:opacity-90"
              )}
            >
              <ArrowDown01Icon className="w-3 h-3" />
              New content
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

TranscriptionPanel.displayName = 'TranscriptionPanel';
