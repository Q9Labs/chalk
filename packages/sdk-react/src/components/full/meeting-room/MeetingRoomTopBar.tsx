import type React from "react";

import { ColumnIcon, LayoutGridIcon, Maximize01Icon, Moon02Icon, Sun02Icon } from "../../../utils/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui";
import type { MeetingLayout, MeetingPanel } from "./types";

interface MeetingRoomTopBarProps {
  isMobile: boolean;
  roomName: string;
  activePanel: MeetingPanel | null;
  layout: MeetingLayout;
  setLayout: (layout: MeetingLayout) => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  pillRef: React.RefObject<HTMLDivElement | null>;
  pillDragHandlers: React.HTMLAttributes<HTMLDivElement>;
}

export function MeetingRoomTopBar({ isMobile, roomName, activePanel, layout, setLayout, isDarkMode, onToggleTheme, pillRef, pillDragHandlers }: MeetingRoomTopBarProps) {
  if (isMobile) {
    return null;
  }

  return (
    <>
      <div ref={pillRef} {...pillDragHandlers} className="absolute top-4 left-6 z-30">
        <div className="px-3 py-1 rounded-full bg-black/40 backdrop-blur-md border border-white/10 select-none">
          <span className="text-xs font-medium text-zinc-200 tracking-tight">{roomName}</span>
        </div>
      </div>

      {!activePanel && (
        <div className="absolute top-4 right-4 z-20 group" role="region" aria-label="Layout controls" onMouseEnter={(e) => (e.currentTarget.dataset.hovered = "true")} onMouseLeave={(e) => (e.currentTarget.dataset.hovered = "false")}>
          <div className="flex flex-row-reverse items-center bg-black/40 backdrop-blur-md rounded-lg p-1 border border-white/10 gap-1 transition-all duration-300">
            <div className="flex items-center justify-center rounded-md w-7 h-7 text-white bg-teal-600 cursor-default shadow-sm">
              {layout === "grid" && <LayoutGridIcon className="w-3.5 h-3.5" />}
              {layout === "spotlight" && <Maximize01Icon className="w-3.5 h-3.5" />}
              {layout === "sidebar" && <ColumnIcon className="w-3.5 h-3.5" />}
            </div>

            <div className="flex items-center gap-1 max-w-0 overflow-hidden opacity-0 group-hover:max-w-[200px] group-hover:opacity-100 group-focus-within:max-w-[200px] group-focus-within:opacity-100 transition-all duration-300 ease-in-out">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onToggleTheme}
                      className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                      aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                    >
                      {isDarkMode ? <Sun02Icon className="w-3.5 h-3.5" /> : <Moon02Icon className="w-3.5 h-3.5" />}
                    </button>
                  }
                />
                <TooltipContent side="bottom">{isDarkMode ? "Light Mode" : "Dark Mode"}</TooltipContent>
              </Tooltip>

              <div className="w-px h-4 bg-white/10 mx-1" />

              {layout !== "grid" && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button type="button" onClick={() => setLayout("grid")} className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500" aria-label="Grid layout">
                        <LayoutGridIcon className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">Grid</TooltipContent>
                </Tooltip>
              )}
              {layout !== "spotlight" && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setLayout("spotlight")}
                        className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                        aria-label="Spotlight layout"
                      >
                        <Maximize01Icon className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">Spotlight</TooltipContent>
                </Tooltip>
              )}
              {layout !== "sidebar" && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setLayout("sidebar")}
                        className="flex items-center justify-center rounded-md w-7 h-7 text-white/80 hover:text-white hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                        aria-label="Sidebar layout"
                      >
                        <ColumnIcon className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">Sidebar</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
