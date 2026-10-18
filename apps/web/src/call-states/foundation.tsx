import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { captureFlip, ChalkButton, ChalkCopyButton, ChalkIconButton, ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkPopover, ChalkSegmentedControl, ChalkSheet, ChalkToggle, ChalkTooltip, ToastStack } from "@q9labsai/chalk-react";

/** Real primitives, in isolation, for the foundation parity and interaction checks. */
export function FoundationKit({ scheme }: { readonly scheme: "dark" | "light" }) {
  const [theme, setTheme] = useState(scheme);
  const [sounds, setSounds] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const moving = useRef<HTMLDivElement>(null);
  return (
    <main data-chalk data-chalk-theme={theme} className="chalk-root chalk-frame" style={{ padding: 24 }}>
      <div className="flex flex-wrap items-center gap-2">
        <ChalkTooltip
          trigger={
            <ChalkIconButton size="lg" aria-label="Foundation icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </ChalkIconButton>
          }
        >
          Foundation icon
        </ChalkTooltip>
        <ChalkIconButton aria-label="Foundation header icon">+</ChalkIconButton>
        <ChalkIconButton size="lg" tone="danger" aria-label="Foundation leave">
          ×
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
        <ChalkButton>Copy link</ChalkButton>
      </ChalkSheet>
      <ToastStack toasts={[{ id: "foundation-join", message: "Nora joined", duration: Infinity }]} onDismiss={() => undefined} />
    </main>
  );
}
