import { useEffect, useMemo, useRef, useState } from "react";
import type { CallStateMeta } from "./states";

type Device = "desktop" | "ipad" | "phone";

const DEVICES: Record<Device, { readonly label: string; readonly width?: number; readonly height?: number }> = {
  desktop: { label: "Desktop" },
  ipad: { label: "iPad", width: 820, height: 1180 },
  phone: { label: "Phone", width: 390, height: 844 },
};

// First match wins, so the group order is also the display order. The dark theme is under review, so Light variants are hidden.
const GROUPS: readonly { readonly title: string; readonly match: RegExp }[] = [
  { title: "Joining", match: /^(states-ready|states-joining|states-ended-join|joining|name-needed|knocking|knock-|waiting-for-host|entering)/ },
  { title: "Call layouts", match: /^(solo|duo|cameras-off|cues|group-|crowd-|recording|stage-(grid|spotlight|solo|duo|avatars|long-names))/ },
  { title: "Screen share", match: /^(share-|stage-board-share|stage-share-(grid|connecting|paused|low-quality|two|audio|local))/ },
  { title: "Board", match: /^(board|stage-board)/ },
  { title: "Chat and people", match: /^(chat$|chat-empty|participants|admission|card-)/ },
  { title: "Menus", match: /^(layout-menu|device-menu|reactions|leave|host-leave)$/ },
  { title: "Toasts and notices", match: /^(states-toast-|hand-peer-toast|media-request|command-error|time-limit-|offline-notice|notice-band|offline-actions|foundation-toast)/ },
  { title: "Reconnecting and ending", match: /^(reconnecting|failed|leaving|left|episode-ended|states-(reconnecting$|left|episode-ended|failed|removed|full|elsewhere))/ },
  { title: "Design foundation", match: /^foundation-/ },
  { title: "App shell", match: /^shell-/ },
];
const OTHER = "Other";

const sentence = (title: string) => title.charAt(0).toUpperCase() + title.slice(1);

export function Gallery({ states }: { readonly states: readonly CallStateMeta[] }) {
  const groups = useMemo(() => {
    const byTitle = new Map<string, CallStateMeta[]>();
    for (const state of states) {
      if (/light/i.test(state.id)) continue;
      const title = GROUPS.find((group) => group.match.test(state.id))?.title ?? OTHER;
      byTitle.set(title, [...(byTitle.get(title) ?? []), state]);
    }
    return [...GROUPS.map((group) => group.title), OTHER].flatMap((title) => {
      const items = byTitle.get(title);
      return items ? [{ title, items }] : [];
    });
  }, [states]);
  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const [selectedId, setSelectedId] = useState(() => {
    const fromHash = location.hash.slice(1);
    return ordered.some((state) => state.id === fromHash) ? fromHash : ordered[0]!.id;
  });
  const [device, setDevice] = useState<Device>("desktop");
  const selectedButton = useRef<HTMLButtonElement>(null);
  const selected = ordered.find((state) => state.id === selectedId) ?? ordered[0]!;

  useEffect(() => {
    history.replaceState(null, "", `#${selectedId}`);
    selectedButton.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => {
    const step = (event: KeyboardEvent) => {
      const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
      if (delta === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      const index = ordered.findIndex((state) => state.id === selectedId);
      setSelectedId(ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))]!.id);
    };
    window.addEventListener("keydown", step);
    return () => window.removeEventListener("keydown", step);
  }, [ordered, selectedId]);

  const frame = DEVICES[device];

  return (
    <div className="flex h-screen bg-black font-sans text-[#e9e9e9]">
      <aside className="flex w-80 shrink-0 flex-col border-r border-white/[0.045] bg-[#060606]">
        <header className="border-b border-white/[0.045] px-5 py-4">
          <h1 className="text-base font-semibold">Chalk call states</h1>
          <p className="mt-1 text-xs text-white/50">{ordered.length} states, dark theme. Use the arrow keys to move through them.</p>
        </header>
        <nav className="flex-1 overflow-y-auto pb-6" aria-label="Call states">
          {groups.map((group) => (
            <section key={group.title}>
              <h2 className="sticky top-0 bg-[#060606] px-5 pb-1.5 pt-5 text-[11px] font-medium uppercase tracking-wider text-white/45">{group.title}</h2>
              <ul className="px-2">
                {group.items.map((state) => {
                  const active = state.id === selected.id;
                  return (
                    <li key={state.id}>
                      <button
                        ref={active ? selectedButton : undefined}
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => setSelectedId(state.id)}
                        className={`w-full rounded-lg px-3 py-1.5 text-left text-[13px] leading-snug outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${active ? "bg-[#1f1f1f] text-white" : "text-white/70 hover:bg-[#161616] hover:text-white"}`}
                      >
                        {sentence(state.title)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-4 border-b border-white/[0.045] px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium">{sentence(selected.title)}</h2>
            <p className="truncate font-mono text-xs text-white/40">{selected.id}</p>
          </div>
          <div role="group" aria-label="Screen size" className="flex gap-0.5 rounded-lg bg-[#0c0c0c] p-0.5">
            {(Object.keys(DEVICES) as Device[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={device === key}
                onClick={() => setDevice(key)}
                className={`rounded-md px-3 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${device === key ? "bg-[#1f1f1f] text-white" : "text-white/60 hover:bg-[#161616] hover:text-white"}`}
              >
                {DEVICES[key].label}
              </button>
            ))}
          </div>
          <a href={`?state=${selected.id}`} target="_blank" rel="noopener" className="rounded-lg px-3 py-1 text-xs text-white/60 outline-none hover:bg-[#161616] hover:text-white focus-visible:ring-1 focus-visible:ring-white/40">
            Open on its own
          </a>
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
          <iframe key={`${selected.id}-${device}`} title={selected.title} src={`?state=${selected.id}`} style={{ width: frame.width ?? "100%", height: frame.height ? Math.min(frame.height, window.innerHeight - 100) : "100%" }} className="max-w-full rounded-xl border border-white/[0.08] bg-black" />
        </div>
      </main>
    </div>
  );
}
