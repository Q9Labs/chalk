import type React from "react";

import { cn } from "../../../utils/cn";
import { useHaptics } from "../../../hooks/ui/useHaptics";
import { Moon02Icon, Sun02Icon } from "../../../utils/icons";

interface PreJoinHeaderProps {
  roomName?: string;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  variant?: "desktop" | "mobile";
}

export function PreJoinHeader({ roomName, isDarkMode, onToggleTheme, variant = "desktop" }: PreJoinHeaderProps): React.JSX.Element {
  const { trigger } = useHaptics();
  const isMobile = variant === "mobile";

  const logoStyle = {
    width: "auto",
    height: "auto",
    maxWidth: isMobile ? "120px" : "clamp(140px, 24vw, 240px)",
    maxHeight: isMobile ? "48px" : "clamp(56px, 12vh, 120px)",
  } satisfies React.CSSProperties;

  return (
    <div className={cn("flex justify-between items-center w-full gap-4", isMobile ? "px-4 py-3" : "px-6 lg:px-8 py-6 max-w-6xl mx-auto md:items-center")}>
      <div className={cn("flex items-center min-w-0", isMobile ? "gap-2" : "gap-3 md:gap-4")}>
        <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" className={cn("block shrink-0", isMobile && "invert")} style={logoStyle} draggable={false} />
        {roomName && !isMobile && (
          <>
            <div className="hidden sm:block w-px h-6 bg-border/60 mx-1 shrink-0" />
            <span className="text-sm font-semibold text-(--muted-foreground) truncate max-w-[240px]">{roomName}</span>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          void trigger("selection");
          onToggleTheme();
        }}
        title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
        aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
        className={cn("rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95", isMobile ? "w-10 h-10 bg-white/20 text-white hover:bg-white/30 shadow-lg" : "w-11 h-11 hover:bg-muted text-foreground shadow-sm hover:shadow-md")}
      >
        {isDarkMode ? <Sun02Icon size={isMobile ? 20 : 22} /> : <Moon02Icon size={isMobile ? 20 : 22} />}
      </button>
    </div>
  );
}
