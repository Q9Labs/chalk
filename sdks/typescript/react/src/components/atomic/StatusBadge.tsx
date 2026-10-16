import React from "react";
import { ClassicStatusBadge } from "./ClassicStatusBadge";

export interface StatusBadgeProps {
  status: "recording" | "live" | "transcribing" | "connecting" | "reconnecting";
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export const StatusBadge = React.memo((props: StatusBadgeProps) => {
  return <ClassicStatusBadge {...props} />;
});

StatusBadge.displayName = "StatusBadge";
