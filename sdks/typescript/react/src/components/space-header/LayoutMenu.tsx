import { Menu } from "@base-ui/react/menu";
import React, { type RefObject } from "react";

import { cn } from "../../utils/cn";
import { ArrowDown01Icon, LayoutGridIcon, Maximize01Icon, Monitor01Icon, Tick01Icon } from "../../utils/icons";
import { ChalkIconButton } from "../chalk-ui";
import type { SpaceHeaderProps } from "./SpaceHeader";

export type StageLayoutValue = NonNullable<SpaceHeaderProps["layout"]>;

export const LAYOUT_OPTIONS = [
  { value: "focus", label: "Spotlight", description: "One big tile, everyone else in a strip", Icon: Maximize01Icon },
  { value: "grid", label: "Grid", description: "Everyone the same size", Icon: LayoutGridIcon },
  { value: "presentation", label: "Presentation", description: "Shared content first, people beside it", Icon: Monitor01Icon },
] as const satisfies readonly { value: StageLayoutValue; label: string; description: string; Icon: typeof LayoutGridIcon }[];

const isLayoutValue = (value: unknown): value is StageLayoutValue => LAYOUT_OPTIONS.some((option) => option.value === value);

export interface LayoutMenuProps {
  readonly layout: StageLayoutValue;
  readonly onLayoutChange: (layout: StageLayoutValue) => void;
  /** Element inside the Chalk root that hosts the popup so it inherits the theme tokens. */
  readonly container: RefObject<HTMLElement | null>;
  readonly skin: "classic" | "chalk";
}

const CLASSIC_TRIGGER =
  "flex h-8 items-center gap-0.5 rounded-full pr-1.5 pl-2 text-[var(--chalk-app-text-muted)] transition hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] data-[popup-open]:bg-[var(--chalk-app-control-hover)] data-[popup-open]:text-[var(--chalk-app-text)]";
const POPUP =
  "z-50 w-max min-w-[248px] max-w-[min(320px,calc(100vw-24px))] origin-[var(--transform-origin)] rounded-[12px] bg-[var(--chalk-app-panel)] p-1.5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] ring-1 ring-[var(--chalk-app-line)] outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";
const ITEM = "flex cursor-default items-center gap-3 rounded-[8px] px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-[var(--chalk-app-control-hover)]";

/** Single header button showing the current stage layout; opens a menu with the three layouts. */
export function LayoutMenu({ layout, onLayoutChange, container, skin }: LayoutMenuProps): React.JSX.Element {
  const current = LAYOUT_OPTIONS.find((option) => option.value === layout) ?? LAYOUT_OPTIONS[0];
  const label = `Layout: ${current.label}`;
  return (
    <Menu.Root>
      {skin === "classic" ? (
        <Menu.Trigger className={CLASSIC_TRIGGER} aria-label={label} title={label}>
          <current.Icon size={17} />
          <ArrowDown01Icon size={12} className="opacity-70" />
        </Menu.Trigger>
      ) : (
        <Menu.Trigger render={<ChalkIconButton aria-label={label} className="w-auto gap-0.5 px-2 text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" seed="space-header-layout" size="sm" title={label} />}>
          <current.Icon size={16} />
          <ArrowDown01Icon size={12} className="opacity-70" />
        </Menu.Trigger>
      )}
      <Menu.Portal container={container}>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={POPUP}>
            <Menu.RadioGroup value={layout} onValueChange={(value: unknown) => isLayoutValue(value) && onLayoutChange(value)}>
              {LAYOUT_OPTIONS.map(({ value, label: optionLabel, description, Icon }) => (
                <Menu.RadioItem key={value} value={value} className={ITEM}>
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[var(--chalk-app-control-group)]", value === layout && "bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]")}>
                    <Icon size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{optionLabel}</span>
                    <span className="text-[12px] text-[var(--chalk-app-text-muted)]">{description}</span>
                  </span>
                  <Menu.RadioItemIndicator className="shrink-0 text-[var(--chalk-app-text)]">
                    <Tick01Icon size={16} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

LayoutMenu.displayName = "LayoutMenu";
