import React from "react";
import { ClassicTranscriptLine } from "./ClassicTranscriptLine";

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
  isLocalParticipant?: boolean;
  showAvatar?: boolean;
  showHeader?: boolean;
  searchHighlight?: string;
  isCurrentMatch?: boolean;
  className?: string;
}

export const TranscriptLine = React.memo<TranscriptLineProps>((props) => {
  return <ClassicTranscriptLine {...props} />;
});

TranscriptLine.displayName = "TranscriptLine";
