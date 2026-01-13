import React, { useMemo, useRef, useEffect, useState } from 'react';
import { X, Search, ArrowDown } from 'lucide-react';
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
  variant?: 'default' | 'sidebar';
  className?: string;
}

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
    const colors = [
      '#FFFFFF',
      '#FFFFFF',
      '#F59E0B',
      '#EC4899',
      '#8B5CF6',
      '#3B82F6',
    ];
    let hash = 0;
    for (let i = 0; i < speakerId.length; i++) {
      hash = speakerId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  if (variant === 'sidebar') {
    return (
      <div 
        className={cn(
          "flex flex-col h-full w-full overflow-hidden font-sans relative",
          !prefersReducedMotion && "chalk-animate-slide-right",
          className
        )}
        style={{
          background: '#151515'
        }}
        data-tour="transcription-panel"
        role="complementary"
        aria-label="Live transcription"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-5">
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-white tracking-tight">Transcription</h2>
            {isLive && <StatusBadge status="transcribing" size="sm" pulse />}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white transition-colors p-1"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
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
                icon={<Search className="w-4 h-4" />}
                iconPosition="left"
                className="w-full"
                size="sm"
              />
            </div>
          )}

          {/* Transcripts Container with Glass Effect */}
          <div 
            ref={containerRef}
            className="rounded-2xl overflow-hidden p-4 space-y-3 relative"
            style={{
              backgroundColor: '#0f0707ff',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              minHeight: '300px'
            }}
            onScroll={handleScroll}
          >
            {filteredTranscripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-gray-500">
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
                  className="bg-[#151515] text-white px-3 py-1 rounded-full text-xs shadow-lg flex items-center gap-1 pointer-events-auto hover:bg-[#252525] transition-colors"
                >
                  <ArrowDown className="w-3 h-3" />
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
        "flex flex-col bg-chalk-bg-surface border-chalk-border-subtle shadow-xl",
        position === 'right' ? cn("h-full w-80 border-l", !prefersReducedMotion && "chalk-animate-slide-right") : cn("w-full h-64 border-t", !prefersReducedMotion && "chalk-animate-slide-up"),
        className
      )}
      data-tour="transcription-panel"
      role="complementary"
      aria-label="Live transcription"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-chalk-text-primary">Transcription</h2>
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
              icon={<X className="w-4 h-4" />} 
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
            icon={<Search className="w-4 h-4" />}
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
          <div className="h-full flex flex-col items-center justify-center text-center text-chalk-text-muted opacity-60">
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
              className="bg-chalk-accent text-white px-3 py-1 rounded-full text-xs shadow-lg flex items-center gap-1 pointer-events-auto hover:bg-chalk-accent-hover transition-colors"
            >
              <ArrowDown className="w-3 h-3" />
              New content
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

TranscriptionPanel.displayName = 'TranscriptionPanel';
