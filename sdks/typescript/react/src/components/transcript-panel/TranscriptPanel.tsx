import React from "react";
import { ClassicTranscriptPanel } from "./ClassicTranscriptPanel";
import { type TranscriptPanelProps } from "./transcript-panel-behavior";

export type { TranscriptEntry, TranscriptPanelProps } from "./transcript-panel-behavior";

export const TranscriptPanel = React.memo((props: TranscriptPanelProps): React.JSX.Element => {
  return <ClassicTranscriptPanel {...props} />;
});

TranscriptPanel.displayName = "TranscriptPanel";
