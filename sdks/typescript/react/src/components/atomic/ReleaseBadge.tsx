import React from "react";
import { cn } from "../../utils/cn";
import { ChalkBadge } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicReleaseBadge } from "./ClassicReleaseBadge";

export interface ReleaseBadgeProps {
  type: "major" | "minor" | "patch";
  className?: string;
}

const typeConfig = {
  major: {
    label: "Major",
    tone: "danger",
  },
  minor: {
    label: "Minor",
    tone: "accent",
  },
  patch: {
    label: "Patch",
    tone: "neutral",
  },
} as const;

export const ReleaseBadge = React.memo<ReleaseBadgeProps>((props) => {
  const skin = useSkin();

  return skin === "classic" ? <ClassicReleaseBadge {...props} /> : <ChalkReleaseBadge {...props} />;
});

function ChalkReleaseBadge({ type, className }: ReleaseBadgeProps) {
  const config = typeConfig[type];

  return (
    <ChalkBadge className={cn("rounded-none px-2 py-0.5 text-xs font-medium", className)} seed={`release-${type}`} tone={config.tone}>
      {config.label}
    </ChalkBadge>
  );
}

ReleaseBadge.displayName = "ReleaseBadge";
