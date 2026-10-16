import React from "react";
import { ClassicSpaceHeader } from "./ClassicSpaceHeader";
import { type SpaceHeaderProps } from "./space-header-contract";

export { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

export const SpaceHeader = React.memo<SpaceHeaderProps>((props) => {
  return <ClassicSpaceHeader {...props} />;
});

SpaceHeader.displayName = "SpaceHeader";
