import { useState, type ReactNode } from "react";
import { ChalkIconButton, ChalkSegmentedControl, ChalkSheet } from "../chalk-ui";

export function DockLayout({ layout, onLayoutChange, children, microphone, camera }: { readonly children?: ReactNode; readonly microphone?: ReactNode; readonly camera?: ReactNode; readonly layout: "focus" | "grid"; readonly onLayoutChange: (layout: "focus" | "grid") => void }) {
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
            <svg data-part="dock-layout-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
              <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
              <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
              <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
            </svg>
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
        </div>
        {microphone || camera ? (
          <div className="chalk-shell-more-devices">
            {microphone}
            {camera}
          </div>
        ) : null}
      </ChalkSheet>
    </>
  );
}
