import React from "react";
import { cn } from "../../utils/cn";
import { ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicCaptionLine } from "./ClassicCaptionLine";

export interface CaptionLineProps {
  text: string;
  speaker?: string;
  position?: "top" | "bottom";
  maxLines?: number;
  className?: string;
}

const ChalkCaptionLine = React.memo<CaptionLineProps>(({ text, speaker, position = "bottom", maxLines = 2, className }) => {
  if (!text) return null;

  return (
    <div className={cn("absolute left-1/2 -translate-x-1/2 z-50 w-full max-w-3xl px-4 text-center pointer-events-none", position === "top" ? "top-[10%]" : "bottom-[10%]", className)} role="status" aria-live="polite" aria-atomic="true">
      <ChalkPanel tone="neutral" className="inline-block max-w-full rounded-lg px-4 py-2 text-lg font-medium shadow-lg transition-all duration-200">
        {speaker && <span className="text-[var(--chalk-accent)] font-bold mr-2">{speaker}:</span>}
        <span
          className="line-clamp-none"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {text}
        </span>
      </ChalkPanel>
    </div>
  );
});

export const CaptionLine = React.memo<CaptionLineProps>((props) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicCaptionLine {...props} /> : <ChalkCaptionLine {...props} />;
});

CaptionLine.displayName = "CaptionLine";
