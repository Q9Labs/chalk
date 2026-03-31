import type React from "react";

import { useHaptics } from "../../../hooks/ui/useHaptics";
import { Moon02Icon, Sun02Icon } from "../../../utils/icons";

interface PreJoinHeaderProps {
  roomName?: string;
  isDarkMode: boolean;
  onToggleTheme: () => void;
}

export function PreJoinHeader({ roomName, isDarkMode, onToggleTheme }: PreJoinHeaderProps): React.JSX.Element {
  const { trigger } = useHaptics();
  const logoStyle = {
    width: "auto",
    height: "auto",
    maxWidth: "clamp(140px, 24vw, 240px)",
    maxHeight: "clamp(56px, 12vh, 120px)",
  } satisfies React.CSSProperties;

  return (
    <div className="flex justify-between items-start md:items-center px-6 lg:px-8 py-6 w-full max-w-6xl mx-auto gap-4">
      <div className="flex items-center gap-3 md:gap-4 min-w-0">
        <img src="/chalk-logo.svg" alt="Chalk" className="block shrink-0" style={logoStyle} draggable={false} />
        {roomName && (
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
        className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 hover:bg-muted hover:scale-105 active:scale-95 text-foreground shadow-sm hover:shadow-md"
      >
        {isDarkMode ? <Sun02Icon size={22} /> : <Moon02Icon size={22} />}
      </button>
    </div>
  );
}
