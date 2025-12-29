import { useState, useCallback, useMemo } from 'react';

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  language?: string;
}

export interface UseTranscriptionOptions {
  enabled?: boolean;
  language?: string;
  showInterim?: boolean;
}

export interface UseTranscriptionReturn {
  transcripts: TranscriptEntry[];
  isEnabled: boolean;
  isTranscribing: boolean;
  setEnabled: (enabled: boolean) => void;
  addTranscript: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => void;
  updateInterim: (speakerId: string, text: string) => void;
  finalizeInterim: (speakerId: string) => void;
  clearTranscripts: () => void;
  exportTranscripts: (format: 'txt' | 'srt' | 'vtt') => string;
  searchTranscripts: (query: string) => TranscriptEntry[];
}

export function useTranscription(options: UseTranscriptionOptions = {}): UseTranscriptionReturn {
  const { enabled: initialEnabled = false, showInterim = true } = options;

  const [isEnabled, setIsEnabled] = useState(initialEnabled);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [interimTranscripts, setInterimTranscripts] = useState<Map<string, TranscriptEntry>>(new Map());

  const setEnabled = useCallback((enabled: boolean) => {
    setIsEnabled(enabled);
    setIsTranscribing(enabled);
  }, []);

  const addTranscript = useCallback((entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => {
    const newEntry: TranscriptEntry = {
      ...entry,
      id: `transcript-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date(),
    };
    setTranscripts(prev => [...prev, newEntry]);
  }, []);

  const updateInterim = useCallback((speakerId: string, text: string) => {
    setInterimTranscripts(prev => {
      const updated = new Map(prev);
      updated.set(speakerId, {
        id: `interim-${speakerId}`,
        speaker: speakerId,
        speakerId,
        text,
        timestamp: new Date(),
        isInterim: true,
      });
      return updated;
    });
  }, []);

  const finalizeInterim = useCallback((speakerId: string) => {
    setInterimTranscripts(prev => {
      const interim = prev.get(speakerId);
      if (interim && interim.text.trim()) {
        // Convert interim to final transcript
        addTranscript({
          speaker: interim.speaker,
          speakerId: interim.speakerId,
          text: interim.text,
          isInterim: false,
        });
      }
      const updated = new Map(prev);
      updated.delete(speakerId);
      return updated;
    });
  }, [addTranscript]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
    setInterimTranscripts(new Map());
  }, []);

  const exportTranscripts = useCallback((format: 'txt' | 'srt' | 'vtt'): string => {
    switch (format) {
      case 'txt':
        return transcripts
          .map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.speaker}: ${t.text}`)
          .join('\n');

      case 'srt':
        return transcripts
          .map((t, i) => {
            const start = formatTimestamp(t.timestamp, 'srt');
            const end = formatTimestamp(
              new Date(t.timestamp.getTime() + 3000),
              'srt'
            );
            return `${i + 1}\n${start} --> ${end}\n${t.speaker}: ${t.text}\n`;
          })
          .join('\n');

      case 'vtt':
        const header = 'WEBVTT\n\n';
        const content = transcripts
          .map(t => {
            const start = formatTimestamp(t.timestamp, 'vtt');
            const end = formatTimestamp(
              new Date(t.timestamp.getTime() + 3000),
              'vtt'
            );
            return `${start} --> ${end}\n<v ${t.speaker}>${t.text}\n`;
          })
          .join('\n');
        return header + content;

      default:
        return '';
    }
  }, [transcripts]);

  const searchTranscripts = useCallback((query: string): TranscriptEntry[] => {
    if (!query.trim()) return transcripts;
    const lowerQuery = query.toLowerCase();
    return transcripts.filter(
      t => 
        t.text.toLowerCase().includes(lowerQuery) ||
        t.speaker.toLowerCase().includes(lowerQuery)
    );
  }, [transcripts]);

  // Combine final + interim transcripts for display
  const allTranscripts = useMemo(() => {
    if (!showInterim) return transcripts;
    return [...transcripts, ...Array.from(interimTranscripts.values())];
  }, [transcripts, interimTranscripts, showInterim]);

  return {
    transcripts: allTranscripts,
    isEnabled,
    isTranscribing,
    setEnabled,
    addTranscript,
    updateInterim,
    finalizeInterim,
    clearTranscripts,
    exportTranscripts,
    searchTranscripts,
  };
}

// Helper function
function formatTimestamp(date: Date, format: 'srt' | 'vtt'): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');

  if (format === 'srt') {
    return `${hours}:${minutes}:${seconds},${ms}`;
  }
  return `${hours}:${minutes}:${seconds}.${ms}`;
}
