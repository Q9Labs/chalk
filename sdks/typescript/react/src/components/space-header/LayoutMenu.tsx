import type { RefObject } from "react";
import { ChalkIconButton, ChalkMenu, ChalkMenuItem, ChalkMenuLabel } from "../chalk-ui";
import { LayoutGridIcon } from "../../utils/icons";
export type StageLayoutValue = "grid" | "focus";
export const LAYOUT_OPTIONS = [
  { value: "focus", label: "Spotlight", description: "One large tile with others beside it" },
  { value: "grid", label: "Grid", description: "People and shared content together" },
] as const;
export interface LayoutMenuProps {
  readonly layout: StageLayoutValue;
  readonly onLayoutChange: (layout: StageLayoutValue) => void;
  readonly container?: RefObject<HTMLElement | null>;
}
export function LayoutMenu({ layout, onLayoutChange }: LayoutMenuProps) {
  return (
    <ChalkMenu
      trigger={
        <ChalkIconButton aria-label={`Layout: ${layout === "grid" ? "Grid" : "Spotlight"}`}>
          <LayoutGridIcon />
        </ChalkIconButton>
      }
    >
      <ChalkMenuLabel>Layout</ChalkMenuLabel>
      {LAYOUT_OPTIONS.map((option) => (
        <ChalkMenuItem key={option.value} checked={layout === option.value} onClick={() => onLayoutChange(option.value)}>
          {option.label}
        </ChalkMenuItem>
      ))}
    </ChalkMenu>
  );
}
