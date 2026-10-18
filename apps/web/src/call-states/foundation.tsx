import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { captureFlip, ChalkButton, ChalkCopyButton, ChalkIconButton, ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkPopover, ChalkSegmentedControl, ChalkSheet, ChalkToggle, ChalkTooltip, ToastStack, type Toast } from "@q9labsai/chalk-react";

/** Real primitives, in isolation, for the foundation parity and interaction checks. */
export function FoundationKit({ scheme, initialNotice = true }: { readonly scheme: "dark" | "light"; readonly initialNotice?: boolean }) {
  const [theme, setTheme] = useState(scheme);
  const [toasts, setToasts] = useState<Toast[]>(initialNotice ? [{ id: "foundation-join", message: "Nora joined", duration: Infinity }] : []);
  const [sounds, setSounds] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [layout, setLayout] = useState("spotlight");
  const moving = useRef<HTMLDivElement>(null);
  return (
    <main data-chalk data-chalk-theme={theme} className="chalk-root chalk-frame" style={{ padding: 24 }}>
      <div className="flex flex-wrap items-center gap-2">
        <ChalkTooltip
          trigger={
            <ChalkIconButton size="lg" aria-label="Foundation icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path className="hidden min-[641px]:block" d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
                <path className="min-[641px]:hidden" d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
              </svg>
            </ChalkIconButton>
          }
        >
          Foundation icon
        </ChalkTooltip>
        <ChalkIconButton aria-label="Foundation header icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
          </svg>
        </ChalkIconButton>
        <ChalkIconButton size="lg" tone="danger" aria-label="Foundation leave">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path
              transform="rotate(135 12 12)"
              d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"
            />
          </svg>
        </ChalkIconButton>
        <ChalkButton>Foundation pill</ChalkButton>
        <ChalkMenu className="chalk-device-menu" trigger={<ChalkButton>Foundation menu</ChalkButton>}>
          <ChalkMenuLabel>Microphone</ChalkMenuLabel>
          <ChalkMenuItem checked>MacBook Air Microphone</ChalkMenuItem>
          <ChalkMenuItem checked={false}>AirPods Pro</ChalkMenuItem>
        </ChalkMenu>
        <ChalkPopover trigger={<ChalkButton>Foundation popover</ChalkButton>} label="Foundation popover">
          <p>Call details</p>
        </ChalkPopover>
        <ChalkCopyButton text="https://chalkmeet.com/q9-team" />
        <ChalkToggle aria-label="Foundation sounds" pressed={sounds} onPressedChange={setSounds} />
        <ChalkSegmentedControl
          size="compact"
          label="Appearance"
          value={theme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onValueChange={setTheme}
        />
        <ChalkButton onClick={() => setToasts([{ id: "foundation-event", message: "Nora joined" }])}>Foundation toast</ChalkButton>
        <ChalkButton onClick={() => setToasts([{ id: "foundation-error", message: "Something went wrong", type: "error" }])}>Foundation error</ChalkButton>
        <ChalkButton onClick={() => setSheet(true)}>Foundation sheet</ChalkButton>
      </div>
      <ChalkButton
        onClick={() => {
          const play = captureFlip(moving.current ? [moving.current] : []);
          flushSync(() => setFlipped(!flipped));
          play();
        }}
      >
        Move fixture
      </ChalkButton>
      <div ref={moving} data-part="flip-fixture" style={{ width: flipped ? 160 : 80, height: 80, marginLeft: flipped ? 120 : 0, background: "var(--chalk-raised)" }}>
        Same node
      </div>
      <ChalkSheet open={sheet} onOpenChange={setSheet} title="More">
        <div style={{ fontSize: 16 }}>
          <ChalkSegmentedControl
            label="Layout"
            value={layout}
            options={[
              { value: "spotlight", label: "Spotlight" },
              { value: "grid", label: "Grid" },
            ]}
            onValueChange={setLayout}
          />
        </div>
        <ChalkButton>Copy link</ChalkButton>
      </ChalkSheet>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </main>
  );
}
