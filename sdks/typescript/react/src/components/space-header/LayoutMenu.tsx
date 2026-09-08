import { Menu } from "@base-ui/react/menu";
import React, { type RefObject } from "react";

import { cn } from "../../utils/cn";
import { ArrowDown01Icon, LayoutGridIcon, Maximize01Icon, Monitor01Icon } from "../../utils/icons";
import { ChalkIconButton } from "../chalk-ui";
import type { SpaceHeaderProps } from "./space-header-contract";

export type StageLayoutValue = NonNullable<SpaceHeaderProps["layout"]>;

type LayoutIcon = (props: { size?: number; className?: string }) => React.ReactNode;

export const LAYOUT_OPTIONS = [
  { value: "focus", label: "Spotlight", description: "One large tile with others beside it", Icon: Maximize01Icon },
  { value: "grid", label: "Grid", description: "Everyone gets one equally sized tile", Icon: LayoutGridIcon },
  { value: "presentation", label: "Presentation", description: "Shared content with people alongside", Icon: Monitor01Icon },
] as const satisfies readonly { value: StageLayoutValue; label: string; description: string; Icon: LayoutIcon }[];

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
  "z-50 w-[320px] max-w-[calc(100vw-24px)] origin-[var(--transform-origin)] rounded-[12px] bg-[var(--chalk-app-panel)] p-1.5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] ring-1 ring-[var(--chalk-app-line)] outline-none transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[ending-style]:translate-y-[-2px] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-[-2px] data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none";
const ITEM = "relative z-10 flex h-[54px] cursor-pointer items-center gap-3 rounded-[8px] px-2.5 text-sm outline-none select-none";

/** Single header button showing the current stage layout; opens a menu with the three layouts. */
export function LayoutMenu({ layout, onLayoutChange, container, skin }: LayoutMenuProps): React.JSX.Element {
  const current = LAYOUT_OPTIONS.find((option) => option.value === layout) ?? LAYOUT_OPTIONS[0];
  const selectedIndex = LAYOUT_OPTIONS.findIndex((option) => option.value === current.value);
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
            <Menu.RadioGroup className="relative" value={layout} onValueChange={(value: unknown) => isLayoutValue(value) && onLayoutChange(value)}>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[54px] rounded-[8px] bg-[var(--chalk-app-control-hover)] ring-1 ring-inset ring-[var(--chalk-app-line)] transition-transform duration-[340ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none"
                data-testid="layout-selection"
                style={{ transform: `translate3d(0, ${selectedIndex * 54}px, 0)` }}
              />
              {LAYOUT_OPTIONS.map(({ value, label: optionLabel, description, Icon }) => (
                <Menu.RadioItem key={value} value={value} className={cn(ITEM, value !== layout && "data-[highlighted]:bg-[var(--chalk-app-control-hover)]")} closeOnClick={false}>
                  <span
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[var(--chalk-app-control-group)] text-[var(--chalk-app-text-muted)] transition-[background-color,color] duration-200 motion-reduce:transition-none",
                      value === layout && "bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]",
                    )}
                  >
                    <Icon size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{optionLabel}</span>
                    <span className="text-[12px] text-[var(--chalk-app-text-muted)]">{description}</span>
                  </span>
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
