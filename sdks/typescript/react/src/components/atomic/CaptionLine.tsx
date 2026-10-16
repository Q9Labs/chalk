import React from "react";
import { ClassicCaptionLine } from "./ClassicCaptionLine";

export interface CaptionLineProps {
  text: string;
  speaker?: string;
  position?: "top" | "bottom";
  maxLines?: number;
  className?: string;
}

export const CaptionLine = React.memo<CaptionLineProps>((props) => {
  return <ClassicCaptionLine {...props} />;
});

CaptionLine.displayName = "CaptionLine";
