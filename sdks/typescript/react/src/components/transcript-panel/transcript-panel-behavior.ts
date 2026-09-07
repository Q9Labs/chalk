import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import { useConnection, useSelf } from "../../bindings/hooks";
import { getParticipantColor, getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

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

export type TranscriptExportFormat = "txt" | "srt" | "vtt" | "json";

export interface TranscriptPanelProps {
  showSpeakerNames?: boolean;
  showTimestamps?: boolean;
  showConfidence?: boolean;
  searchable?: boolean;
  onExport?: (format: TranscriptExportFormat) => void;
  onCopyAll?: () => void;
  onClose?: () => void;
  position?: "right" | "bottom";
  variant?: "default" | "sidebar" | "mobile";
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

export interface TranscriptPanelSurfaceProps extends TranscriptPanelProps {
  readonly transcripts: TranscriptEntry[];
  readonly isLive?: boolean;
  readonly localParticipantId?: string;
}

export interface GroupedTranscript {
  speakerId: string;
  speaker: string;
  speakerColor: string;
  isLocalParticipant?: boolean;
  entries: TranscriptEntry[];
}

export interface SearchMatch {
  entryId: string;
  index: number;
}

export function groupTranscriptsBySpeaker(transcripts: readonly TranscriptEntry[]): GroupedTranscript[] {
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

export function findSearchMatches(transcripts: readonly TranscriptEntry[], query: string): SearchMatch[] {
  if (!query.trim()) return [];
  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const [index, entry] of transcripts.entries()) {
    if (entry.text.toLowerCase().includes(lowerQuery) || entry.speaker.toLowerCase().includes(lowerQuery)) {
      matches.push({ entryId: entry.id, index });
    }
  }

  return matches;
}

function filterSupersededInterimTranscripts(transcripts: readonly TranscriptEntry[]): TranscriptEntry[] {
  const filteredTranscripts: TranscriptEntry[] = [];

  for (const [index, current] of transcripts.entries()) {
    const next = transcripts[index + 1];
    if (current.isInterim && next && !next.isInterim && next.speakerId === current.speakerId) {
      continue;
    }
    filteredTranscripts.push(current);
  }

  return filteredTranscripts;
}

function filterGroupsByMatches(groups: readonly GroupedTranscript[], matches: readonly SearchMatch[]): GroupedTranscript[] {
  const matchedIds = new Set(matches.map((match) => match.entryId));
  return groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => matchedIds.has(entry.id)),
    }))
    .filter((group) => group.entries.length > 0);
}

function formatTranscriptsForCopy(transcripts: readonly TranscriptEntry[]): string {
  return transcripts.map((transcript) => `[${transcript.timestamp.toLocaleTimeString()}] ${transcript.speaker}: ${transcript.text}`).join("\n");
}

interface TranscriptPanelBehaviorOptions {
  readonly transcripts: readonly TranscriptEntry[];
  readonly searchable: boolean;
  readonly prefersReducedMotion: boolean;
  readonly onCopyAll?: () => void;
  readonly participantColorSeed?: string;
  readonly localParticipantId?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
}

interface TranscriptPanelBehavior {
  readonly searchQuery: string;
  readonly themeVariables: React.CSSProperties;
  readonly currentMatchIndex: number;
  readonly autoScroll: boolean;
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly endRef: React.RefObject<HTMLDivElement | null>;
  readonly searchInputRef: React.RefObject<HTMLInputElement | null>;
  readonly searchMatches: readonly SearchMatch[];
  readonly currentMatch: SearchMatch | undefined;
  readonly displayedGroups: readonly GroupedTranscript[];
  readonly onScroll: () => void;
  readonly onSearchChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly clearSearch: () => void;
  readonly navigateMatch: (direction: "prev" | "next") => void;
  readonly copyAll: () => void;
  readonly scrollToLatest: () => void;
}

interface TranscriptExportMenuBehavior {
  readonly isOpen: boolean;
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  readonly toggleMenu: () => void;
  readonly selectExport: (format: TranscriptExportFormat) => void;
  readonly selectCopy: () => void;
}

export function useTranscriptExportMenu(onExport?: (format: TranscriptExportFormat) => void, onCopyAll?: () => void): TranscriptExportMenuBehavior {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const toggleMenu = useCallback(() => setIsOpen(!isOpen), [isOpen]);
  const selectExport = useCallback(
    (format: TranscriptExportFormat) => {
      onExport?.(format);
      setIsOpen(false);
    },
    [onExport],
  );
  const selectCopy = useCallback(() => {
    onCopyAll?.();
    setIsOpen(false);
  }, [onCopyAll]);

  return { isOpen, menuRef, toggleMenu, selectExport, selectCopy };
}

export function useConnectedTranscriptPanelBehavior(props: TranscriptPanelProps): TranscriptPanelSurfaceProps {
  const connection = useConnection();
  const self = useSelf();

  return {
    ...props,
    transcripts: [],
    isLive: connection.status === "live" || connection.status === "reconnecting",
    localParticipantId: self.participantId ?? undefined,
    participantColorSeed: props.participantColorSeed ?? self.displayName ?? undefined,
  };
}

export function useTranscriptPanelBehavior({ transcripts, searchable, prefersReducedMotion, onCopyAll, participantColorSeed, localParticipantId, participantGradientPreference }: TranscriptPanelBehaviorOptions): TranscriptPanelBehavior {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed ?? localParticipantId, participantGradientPreference), [participantColorSeed, participantGradientPreference, localParticipantId]);
  const searchMatches = useMemo(() => findSearchMatches(transcripts, searchQuery), [transcripts, searchQuery]);
  const currentMatch = searchMatches[currentMatchIndex];
  const filteredTranscripts = useMemo(() => filterSupersededInterimTranscripts(transcripts), [transcripts]);
  const groupedTranscripts = useMemo(() => groupTranscriptsBySpeaker(filteredTranscripts), [filteredTranscripts]);
  const displayedGroups = useMemo(() => (searchQuery.trim() ? filterGroupsByMatches(groupedTranscripts, searchMatches) : groupedTranscripts), [groupedTranscripts, searchQuery, searchMatches]);

  useEffect(() => {
    if (autoScroll && endRef.current && !searchQuery) {
      endRef.current.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
    }
  }, [transcripts, autoScroll, prefersReducedMotion, searchQuery]);

  useEffect(() => {
    if (currentMatch && containerRef.current) {
      const matchElement = containerRef.current.querySelector('[data-transcript-match="true"]');
      matchElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatch, currentMatchIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "f" && searchable) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }

      if (event.key === "Escape" && searchQuery) {
        setSearchQuery("");
        setCurrentMatchIndex(0);
      }

      if (document.activeElement === searchInputRef.current && searchMatches.length > 0) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          setCurrentMatchIndex((index) => (index + 1) % searchMatches.length);
        } else if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          setCurrentMatchIndex((index) => (index - 1 + searchMatches.length) % searchMatches.length);
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [searchable, searchQuery, searchMatches.length]);

  const onScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }, []);

  const onSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
    setCurrentMatchIndex(0);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setCurrentMatchIndex(0);
    searchInputRef.current?.focus();
  }, []);

  const navigateMatch = useCallback(
    (direction: "prev" | "next") => {
      if (searchMatches.length === 0) return;
      setCurrentMatchIndex((index) => {
        if (direction === "next") {
          return (index + 1) % searchMatches.length;
        }
        return (index - 1 + searchMatches.length) % searchMatches.length;
      });
    },
    [searchMatches.length],
  );

  const copyAll = useCallback(() => {
    if (onCopyAll) {
      onCopyAll();
      return;
    }
    void navigator.clipboard.writeText(formatTranscriptsForCopy(transcripts));
  }, [transcripts, onCopyAll]);

  const scrollToLatest = useCallback(() => {
    setAutoScroll(true);
    endRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [prefersReducedMotion]);

  return {
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
    onScroll,
    onSearchChange,
    clearSearch,
    navigateMatch,
    copyAll,
    scrollToLatest,
  };
}
