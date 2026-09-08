import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import RotateLeft01Icon from "@hugeicons/core-free-icons/RotateLeft01Icon";
import SidebarLeftIcon from "@hugeicons/core-free-icons/SidebarLeftIcon";
import SidebarRightIcon from "@hugeicons/core-free-icons/SidebarRightIcon";
import SlidersHorizontalIcon from "@hugeicons/core-free-icons/SlidersHorizontalIcon";
import { AnimatedCopy01Icon, AnimatedHugeiconsIcon as HugeiconsIcon, type AnimatedCopy01IconHandle } from "@q9labsai/chalk-react/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { PREVIEW_CONTROL_TABS, readPreviewControlTab, readPreviewDockSide, storePreviewControlTab, storePreviewDockSide, type PreviewControlTab, type PreviewDockSide } from "./preview-chrome-preferences";
import { AccessSection, LookSection, MediaSection, SpaceSection, StatesSection } from "./preview-control-sections";
import { paletteLabel, skinLabel, stateLabel, viewLabel } from "./preview-labels";
import { createPreviewHref, DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, SPACE_STATES, type PreviewSearch, type PreviewSearchPatch, type PreviewState } from "./preview-state";

interface PreviewGalleryToolbarProps {
  readonly search: PreviewSearch;
  readonly onChange: (patch: PreviewSearchPatch) => void;
}

const TAB_LABELS: Readonly<Record<PreviewControlTab, string>> = {
  states: "States",
  space: "Space",
  media: "Media",
  access: "Access",
  look: "Look",
};

const TOGGLE_KEY = "`";
const COPY_FEEDBACK_MS = 1600;

const headerButtonClassName = "inline-flex size-8 items-center justify-center rounded-lg text-[#555b65] transition-colors hover:bg-[#eceae4] hover:text-[#202329] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/60 disabled:opacity-40";
const stepButtonClassName = "inline-flex size-7 items-center justify-center rounded-md border border-[#d9d8d2] bg-white text-[#555b65] transition-colors hover:border-[#55aac9] hover:text-[#202329] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/60";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function statesFor(view: PreviewSearch["view"]): readonly PreviewState[] {
  return view === "entrance" ? ENTRANCE_STATES : SPACE_STATES;
}

function stepState(search: PreviewSearch, direction: 1 | -1): PreviewState {
  const states = statesFor(search.view);
  const index = states.indexOf(search.state);
  return states[(index + direction + states.length) % states.length] ?? search.state;
}

function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="rounded border border-[#d9d8d2] bg-white px-1 font-mono text-[11px] text-[#555b65]">{children}</kbd>;
}

function dockClassName(side: PreviewDockSide): string {
  return side === "right" ? "sm:left-auto sm:right-4 justify-end" : "sm:left-4 sm:right-auto justify-start";
}

export function PreviewGalleryToolbar({ search, onChange }: PreviewGalleryToolbarProps) {
  const controlsId = useId();
  const headingId = `${controlsId}-heading`;
  const isVisible = search.chrome === "visible";
  const showButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousVisibilityRef = useRef(isVisible);
  const [dock, setDock] = useState<PreviewDockSide>(readPreviewDockSide);
  const [tab, setTab] = useState<PreviewControlTab>(readPreviewControlTab);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const copyIconRef = useRef<AnimatedCopy01IconHandle>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  useLayoutEffect(() => {
    const previous = previousVisibilityRef.current;
    previousVisibilityRef.current = isVisible;
    if (previous === isVisible) return;
    if (isVisible) headingRef.current?.focus();
    else showButtonRef.current?.focus();
  }, [isVisible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const current = searchRef.current;
      if (event.key === TOGGLE_KEY) {
        event.preventDefault();
        onChange({ chrome: current.chrome === "visible" ? "hidden" : "visible" });
        return;
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        onChange({ state: stepState(current, event.key === "]" ? 1 : -1) });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChange]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const changeDock = (side: PreviewDockSide) => {
    storePreviewDockSide(side);
    setDock(side);
  };
  const changeTab = (next: PreviewControlTab) => {
    storePreviewControlTab(next);
    setTab(next);
  };
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onChange({ chrome: "hidden" });
  };
  const moveTabFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = PREVIEW_CONTROL_TABS.indexOf(tab);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = PREVIEW_CONTROL_TABS[(index + offset + PREVIEW_CONTROL_TABS.length) % PREVIEW_CONTROL_TABS.length] ?? tab;
    changeTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };
  const copyLink = async () => {
    const href = new URL(createPreviewHref(search), window.location.href).toString();
    if (!navigator.clipboard) {
      window.prompt("Copy this preview link", href);
      return;
    }
    await navigator.clipboard.writeText(href);
    setCopyStatus("copied");
    copyIconRef.current?.startAnimation();
  };
  const reset = () => onChange({ ...DEFAULT_PREVIEW_SEARCH, chrome: "visible" });

  const wrapperClassName = `fixed inset-x-2 bottom-24 z-[65] flex sm:bottom-4 ${dockClassName(dock)}`;

  if (!isVisible) {
    return (
      <div className={`${wrapperClassName} pointer-events-none`}>
        <button
          ref={showButtonRef}
          type="button"
          aria-controls={controlsId}
          aria-expanded={false}
          aria-label="Show preview controls"
          title={`Preview controls (${TOGGLE_KEY})`}
          onClick={() => onChange({ chrome: "visible" })}
          className="group pointer-events-auto inline-flex h-9 max-w-9 items-center gap-2 overflow-hidden rounded-full border border-white/15 bg-[#202329]/70 px-2 text-[13px] font-medium text-white/90 opacity-55 shadow-[0_6px_24px_rgba(12,14,18,0.25)] backdrop-blur transition-[max-width,opacity,background-color] duration-300 hover:max-w-64 hover:bg-[#202329]/90 hover:opacity-100 focus-visible:max-w-64 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]"
        >
          <HugeiconsIcon icon={SlidersHorizontalIcon} className="size-[18px] shrink-0" strokeWidth={2} />
          <span className="whitespace-nowrap pr-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">Preview controls</span>
        </button>
      </div>
    );
  }

  const previousState = stepState(search, -1);
  const nextState = stepState(search, 1);
  const summary = `${search.participants} participants · ${search.layout} · ${skinLabel(search.skin)} · ${paletteLabel(search.palette)}`;

  return (
    <div className={`${wrapperClassName} pointer-events-none`}>
      <section
        id={controlsId}
        aria-label="Preview controls"
        aria-labelledby={headingId}
        onKeyDown={closeOnEscape}
        className="pointer-events-auto flex max-h-[min(86vh,760px)] w-[min(440px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-[#d4d3cd] bg-[#fbfaf7]/[0.97] text-[#202329] shadow-[0_24px_70px_rgba(12,14,18,0.22)] backdrop-blur-md"
      >
        <header className="shrink-0 border-b border-[#e6e4de] px-4 pb-3 pt-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold tracking-[-0.01em] outline-none">
              Preview controls
            </h2>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className={headerButtonClassName}
                aria-label={copyStatus === "copied" ? "Preview link copied" : "Copy preview link"}
                title="Copy preview link"
                onClick={() => void copyLink()}
                onMouseEnter={() => copyIconRef.current?.startAnimation()}
                onFocus={() => copyIconRef.current?.startAnimation()}
              >
                <AnimatedCopy01Icon ref={copyIconRef} className={`size-4 ${copyStatus === "copied" ? "text-[#2f8f5b]" : ""}`} size={16} aria-hidden="true" onMouseEnter={() => copyIconRef.current?.startAnimation()} />
              </button>
              <button type="button" className={headerButtonClassName} aria-label="Reset preview to defaults" title="Reset to defaults" onClick={reset}>
                <HugeiconsIcon icon={RotateLeft01Icon} className="size-4" strokeWidth={2} />
              </button>
              <button type="button" className={headerButtonClassName} aria-label={dock === "left" ? "Dock controls to the right" : "Dock controls to the left"} title={dock === "left" ? "Dock right" : "Dock left"} onClick={() => changeDock(dock === "left" ? "right" : "left")}>
                <HugeiconsIcon icon={dock === "left" ? SidebarRightIcon : SidebarLeftIcon} className="size-4" strokeWidth={2} />
              </button>
              <button type="button" className={headerButtonClassName} aria-label="Hide preview controls" title={`Hide (Esc or ${TOGGLE_KEY})`} aria-controls={controlsId} aria-expanded={true} onClick={() => onChange({ chrome: "hidden" })}>
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={stepButtonClassName} aria-label={`Previous state: ${stateLabel(previousState)}`} title={`Previous state: ${stateLabel(previousState)} ([)`} onClick={() => onChange({ state: previousState })}>
              <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" strokeWidth={2} />
            </button>
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" aria-live="polite">
              {viewLabel(search.view)} · {stateLabel(search.state)}
              <span className="ml-2 font-normal text-[#858a92]">{summary}</span>
            </p>
            <button type="button" className={stepButtonClassName} aria-label={`Next state: ${stateLabel(nextState)}`} title={`Next state: ${stateLabel(nextState)} (])`} onClick={() => onChange({ state: nextState })}>
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" strokeWidth={2} />
            </button>
          </div>
        </header>

        <div role="tablist" aria-label="Preview control sections" onKeyDown={moveTabFocus} className="flex shrink-0 gap-1 border-b border-[#e6e4de] px-3 pt-2">
          {PREVIEW_CONTROL_TABS.map((option) => {
            const selected = option === tab;
            return (
              <button
                key={option}
                type="button"
                role="tab"
                data-tab={option}
                id={`${controlsId}-tab-${option}`}
                aria-selected={selected}
                aria-controls={`${controlsId}-panel-${option}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => changeTab(option)}
                className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#55aac9]/60 ${selected ? "border-[#202329] text-[#202329]" : "border-transparent text-[#6d727b] hover:text-[#202329]"}`}
              >
                {TAB_LABELS[option]}
              </button>
            );
          })}
        </div>

        <div id={`${controlsId}-panel-${tab}`} role="tabpanel" aria-labelledby={`${controlsId}-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {tab === "states" ? <StatesSection search={search} onChange={onChange} /> : null}
          {tab === "space" ? <SpaceSection search={search} onChange={onChange} /> : null}
          {tab === "media" ? <MediaSection search={search} onChange={onChange} /> : null}
          {tab === "access" ? <AccessSection search={search} onChange={onChange} /> : null}
          {tab === "look" ? <LookSection search={search} onChange={onChange} /> : null}
        </div>

        <footer className="shrink-0 border-t border-[#e6e4de] px-4 py-2 text-[11px] text-[#858a92]">
          <Kbd>{TOGGLE_KEY}</Kbd> show or hide · <Kbd>Esc</Kbd> hide · <Kbd>[</Kbd> <Kbd>]</Kbd> step states · every change updates the URL
        </footer>
      </section>
    </div>
  );
}
