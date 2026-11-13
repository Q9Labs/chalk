import { useState, type ReactNode } from "react";
import { ChalkIconButton, ChalkSegmentedControl, ChalkSheet } from "../chalk-ui";
import { ShellIcon } from "./ShellIcon";

export function DockLayout({ layout, onLayoutChange, devices, children }: { readonly children?: ReactNode; readonly devices?: ReactNode; readonly layout: "focus" | "grid"; readonly onLayoutChange: (layout: "focus" | "grid") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ChalkIconButton size="lg" aria-label="More options" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path data-part="dock-more-glyph" d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
        </svg>
      </ChalkIconButton>
      <ChalkSheet title="More options" open={open} onOpenChange={setOpen}>
        <div
          data-part="dock-layout-group"
          className="chalk-sheet-group chalk-shell-more-group"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("button.chalk-sheet-row")) setOpen(false);
          }}
        >
          {children}
          <div data-part="dock-layout-row" className="chalk-sheet-row">
            <ShellIcon name="grid" />
            <span data-part="dock-layout-label">Layout</span>
            <ChalkSegmentedControl
              label="Layout"
              value={layout}
              options={[
                { value: "focus", label: "Spotlight" },
                { value: "grid", label: "Grid" },
              ]}
              onValueChange={onLayoutChange}
            />
          </div>
          {devices}
        </div>
      </ChalkSheet>
    </>
  );
}
