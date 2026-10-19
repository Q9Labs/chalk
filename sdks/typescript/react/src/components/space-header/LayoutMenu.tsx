import type { RefObject } from "react";
import { ChalkIconButton, ChalkTooltip } from "../chalk-ui";
import { ShellIcon } from "../control-bar/ShellIcon";
export type StageLayoutValue = "grid" | "focus";
export interface LayoutMenuProps {
  readonly layout: StageLayoutValue;
  readonly onLayoutChange: (layout: StageLayoutValue) => void;
  readonly container?: RefObject<HTMLElement | null>;
}
export function LayoutMenu({ layout, onLayoutChange }: LayoutMenuProps) {
  const label = `Switch to ${layout === "grid" ? "spotlight" : "grid"}`;
  return (
    <ChalkTooltip
      trigger={
        <ChalkIconButton className="chalk-shell-layout" aria-label={label} onClick={() => onLayoutChange(layout === "grid" ? "focus" : "grid")}>
          <ShellIcon name={layout === "grid" ? "spot" : "grid"} />
        </ChalkIconButton>
      }
    >
      {label}
    </ChalkTooltip>
  );
}
