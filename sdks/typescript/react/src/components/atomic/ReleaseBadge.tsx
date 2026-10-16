import React from "react";
import { ClassicReleaseBadge } from "./ClassicReleaseBadge";

export interface ReleaseBadgeProps {
  type: "major" | "minor" | "patch";
  className?: string;
}

export const ReleaseBadge = React.memo<ReleaseBadgeProps>((props) => {
  return <ClassicReleaseBadge {...props} />;
});

ReleaseBadge.displayName = "ReleaseBadge";
