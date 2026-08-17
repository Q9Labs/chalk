"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./lib/utils";
import { usePortalTheme } from "./lib/use-portal-theme";

function Menu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

const menuContentVariants = cva("z-50 min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-xl border p-1 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95", {
  variants: {
    tone: {
      default: "bg-popover text-popover-foreground border-border shadow-[var(--chalk-shadow-md)]",
      sidebar: "bg-sidebar text-sidebar-foreground border-sidebar-border shadow-[0_18px_50px_rgba(0,0,0,0.45)]",
    },
  },
  defaultVariants: { tone: "default" },
});

type MenuContentProps = MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & VariantProps<typeof menuContentVariants>;

function MenuContent({ className, tone, side = "bottom", sideOffset = 6, align = "start", alignOffset = 0, children, ...props }: MenuContentProps) {
  const portalTheme = usePortalTheme();

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-50" side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset}>
        <MenuPrimitive.Popup data-chalk data-chalk-theme={portalTheme} data-slot="menu-content" className={cn("chalk-root", menuContentVariants({ tone }), className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** Highlight rides on `currentColor` so one rule reads correctly on light and chalkboard popups alike. */
const menuItemClassName = "data-highlighted:bg-current/8 relative flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="menu-item" className={cn(menuItemClassName, className)} {...props} />;
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem data-slot="menu-radio-item" className={cn(menuItemClassName, className)} {...props}>
      {children}
      <MenuPrimitive.RadioItemIndicator className="ml-auto flex size-4 shrink-0 items-center justify-center">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

/** Owns the labelled section a `MenuGroupLabel` names; the label throws without it. */
function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuGroupLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="menu-group-label" className={cn("px-2 pt-1.5 pb-1 font-mono text-[10px] tracking-[0.08em] uppercase opacity-60", className)} {...props} />;
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn("bg-current/10 -mx-1 my-1 h-px", className)} {...props} />;
}

export { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger };
