import React from "react";
import { ClassicNameTag } from "./ClassicNameTag";

export interface NameTagProps {
  name: string;
  isLocal?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export const NameTag = React.memo((props: NameTagProps) => {
  return <ClassicNameTag {...props} />;
});

NameTag.displayName = "NameTag";
