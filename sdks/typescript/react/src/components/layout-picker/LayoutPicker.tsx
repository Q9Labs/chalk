import React from "react";
import { GridIcon, SquareIcon, LayoutTableIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { IconButton, Tooltip } from "../atomic";

export interface LayoutPickerProps {
  layout: "grid" | "focus" | "presentation";
  onChange: (layout: "grid" | "focus" | "presentation") => void;
  disabled?: boolean;
  className?: string;
}

export const LayoutPicker = React.memo(({ layout, onChange, disabled, className }: LayoutPickerProps) => {
  return (
    <div className={cn("flex items-center gap-1 p-1 bg-background-secondary rounded-lg border border-border", className)}>
      <Tooltip content="Grid View" position="top">
        <IconButton icon={<GridIcon size={20} />} variant={layout === "grid" ? "default" : "ghost"} size="sm" onClick={() => onChange("grid")} disabled={disabled} aria-label="Switch to grid layout" />
      </Tooltip>

      <Tooltip content="Spotlight View" position="top">
        <IconButton icon={<SquareIcon size={20} />} variant={layout === "focus" ? "default" : "ghost"} size="sm" onClick={() => onChange("focus")} disabled={disabled} aria-label="Switch to spotlight layout" />
      </Tooltip>

      <Tooltip content="Sidebar View" position="top">
        <IconButton icon={<LayoutTableIcon size={20} />} variant={layout === "presentation" ? "default" : "ghost"} size="sm" onClick={() => onChange("presentation")} disabled={disabled} aria-label="Switch to sidebar layout" />
      </Tooltip>
    </div>
  );
});

LayoutPicker.displayName = "LayoutPicker";
