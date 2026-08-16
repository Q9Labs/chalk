"use client";

import * as React from "react";
import { Drawer } from "@base-ui/react/drawer";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./lib/utils";
import { useIsMobile } from "./lib/use-is-mobile";
import { resolvePortalThemeFromDocument } from "./lib/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const SIDEBAR_COOKIE_NAME = "chalk_sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarState = "expanded" | "collapsed";
type SidebarSide = "left" | "right";
type SidebarVariant = "sidebar" | "floating";
type SidebarCollapsible = "offcanvas" | "icon" | "none";

interface SidebarContextValue {
  readonly state: SidebarState;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly openMobile: boolean;
  readonly setOpenMobile: (open: boolean) => void;
  readonly isMobile: boolean;
  readonly toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used inside a SidebarProvider");
  return context;
}

interface SidebarProviderProps extends React.ComponentPropsWithRef<"div"> {
  /** Initial expanded state when the sidebar is uncontrolled. */
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

function SidebarProvider({ defaultOpen = true, open: openProp, onOpenChange, className, children, ...props }: SidebarProviderProps) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (onOpenChange) onOpenChange(value);
      else setUncontrolledOpen(value);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
    },
    [onOpenChange],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile(!openMobile);
    else setOpen(!open);
  }, [isMobile, open, openMobile, setOpen]);

  React.useEffect(() => {
    const toggleOnShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== SIDEBAR_KEYBOARD_SHORTCUT || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", toggleOnShortcut);
    return () => window.removeEventListener("keydown", toggleOnShortcut);
  }, [toggleSidebar]);

  const value = React.useMemo<SidebarContextValue>(() => ({ state: open ? "expanded" : "collapsed", open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar }), [isMobile, open, openMobile, setOpen, toggleSidebar]);

  return (
    <SidebarContext.Provider value={value}>
      <div data-slot="sidebar-wrapper" className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)} {...props}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

interface SidebarProps extends React.ComponentPropsWithRef<"div"> {
  readonly side?: SidebarSide;
  readonly variant?: SidebarVariant;
  readonly collapsible?: SidebarCollapsible;
  /** Accessible name for the mobile drawer. */
  readonly title?: string;
}

function Sidebar({ side = "left", variant = "sidebar", collapsible = "icon", title = "Navigation", className, children, ...props }: SidebarProps) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    const portalTheme = resolvePortalThemeFromDocument();
    return (
      <Drawer.Root open={openMobile} onOpenChange={setOpenMobile} swipeDirection={side}>
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Drawer.Viewport className={cn("fixed inset-y-0 z-50 flex", side === "left" ? "left-0" : "right-0")}>
            <Drawer.Popup
              data-chalk
              data-chalk-theme={portalTheme}
              data-slot="sidebar"
              data-mobile="true"
              className={cn(
                "chalk-root bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width-mobile) flex-col transition-transform duration-300 ease-out",
                side === "left" ? "data-ending-style:-translate-x-full data-starting-style:-translate-x-full" : "data-ending-style:translate-x-full data-starting-style:translate-x-full",
                className,
              )}
            >
              <Drawer.Title className="sr-only">{title}</Drawer.Title>
              {children}
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  if (collapsible === "none") {
    return (
      <div data-chalk data-slot="sidebar" className={cn("bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col", className)} {...props}>
        {children}
      </div>
    );
  }

  return (
    <div data-chalk data-slot="sidebar" data-state={state} data-collapsible={state === "collapsed" ? collapsible : ""} data-variant={variant} data-side={side} className="group peer text-sidebar-foreground hidden bg-transparent md:block">
      {/* Reserves the layout track that the fixed panel floats above. */}
      <div
        className={cn(
          "relative h-svh w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[collapsible=offcanvas]:w-0",
          variant === "floating" ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]" : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <div
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex",
          side === "left" ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]" : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
          variant === "floating" ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]" : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          className,
        )}
        {...props}
      >
        <div data-sidebar="sidebar" className={cn("bg-sidebar flex h-full w-full flex-col", variant === "floating" ? "border-sidebar-border rounded-xl border shadow-[var(--chalk-shadow-lg)]" : "")}>
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarInset({ className, ...props }: React.ComponentPropsWithRef<"main">) {
  return <main data-slot="sidebar-inset" className={cn("relative flex w-full min-w-0 flex-1 flex-col", className)} {...props} />;
}

function SidebarTrigger({ className, onClick, children, ...props }: React.ComponentPropsWithRef<"button">) {
  const { toggleSidebar, isMobile, open } = useSidebar();

  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      aria-label={isMobile || !open ? "Open navigation" : "Collapse navigation"}
      aria-expanded={isMobile ? undefined : open}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      className={cn("text-foreground/70 hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-[3px] [&_svg]:size-4.5", className)}
      {...props}
    >
      {children ?? <PanelLeftIcon />}
    </button>
  );
}

/** The hairline hit area on the sidebar's edge; drag-to-toggle affordance. */
function SidebarRail({ className, ...props }: React.ComponentPropsWithRef<"button">) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="Toggle navigation"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle navigation"
      className={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] sm:flex",
        "in-data-[side=left]:-right-4 in-data-[side=right]:left-0",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "in-data-[collapsible=offcanvas]:hover:bg-sidebar in-data-[collapsible=offcanvas]:translate-x-0 in-data-[collapsible=offcanvas]:after:left-full",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="sidebar-header" data-sidebar="header" className={cn("flex flex-col gap-2 p-3", className)} {...props} />;
}

function SidebarContent({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="sidebar-content" data-sidebar="content" className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 group-data-[collapsible=icon]:overflow-hidden", className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn("border-sidebar-border flex flex-col gap-1 border-t p-3", className)} {...props} />;
}

function SidebarGroup({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="sidebar-group" data-sidebar="group" className={cn("relative flex w-full min-w-0 flex-col", className)} {...props} />;
}

function SidebarGroupLabel({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "text-sidebar-foreground/55 flex h-8 shrink-0 items-center rounded-md px-2 font-mono text-[10px] tracking-[0.09em] uppercase transition-[margin,opacity] duration-200 ease-linear",
        "group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentPropsWithRef<"ul">) {
  return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn("flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentPropsWithRef<"li">) {
  return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button ring-sidebar-ring flex w-full items-center gap-3 overflow-hidden rounded-lg px-2.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! [&>span:last-child]:truncate [&>svg]:size-4.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
        outline: "border-sidebar-border hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground border bg-transparent",
        primary: "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 justify-start",
      },
      size: {
        default: "h-9",
        lg: "h-12 group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

interface SidebarMenuButtonProps extends React.ComponentPropsWithRef<"button">, VariantProps<typeof sidebarMenuButtonVariants> {
  readonly isActive?: boolean;
  /** Shown as a tooltip while the sidebar is collapsed to icons. */
  readonly tooltip?: React.ReactNode;
  /** Renders a different element — a router link, for instance — with the button's props. */
  readonly render?: useRender.RenderProp;
}

function SidebarMenuButton({ render, isActive = false, variant, size, tooltip, className, ...props }: SidebarMenuButtonProps) {
  const { isMobile, state } = useSidebar();
  const element = useRender({
    render,
    defaultTagName: "button",
    state: {},
    props: {
      type: render ? undefined : "button",
      "data-slot": "sidebar-menu-button",
      "data-sidebar": "menu-button",
      "data-active": isActive,
      className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      ...props,
    },
  });

  if (!tooltip || isMobile || state !== "collapsed") return element;

  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent side="right" sideOffset={10}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function PanelLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

export { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, sidebarMenuButtonVariants, useSidebar };
