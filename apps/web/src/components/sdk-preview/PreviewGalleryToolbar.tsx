import { useId, type MouseEvent } from "react";
import { Button } from "@q9labsai/chalk-react/ui";

import {
  createPreviewHref,
  ENTRANCE_STATES,
  patchPreviewSearch,
  PREVIEW_CHAT_STATES,
  PREVIEW_DIALOGS,
  PREVIEW_LAYOUTS,
  PREVIEW_PANELS,
  PREVIEW_PARTICIPANT_COUNTS,
  PREVIEW_PALETTES,
  PREVIEW_STAGES,
  PREVIEW_TEXTURES,
  PREVIEW_TOASTS,
  PREVIEW_VIEWS,
  SPACE_STATES,
  type PreviewSearch,
  type PreviewSearchPatch,
  type PreviewState,
} from "./preview-state";

interface PreviewGalleryToolbarProps {
  readonly search: PreviewSearch;
  readonly onChange: (patch: PreviewSearchPatch) => void;
}

const fieldClassName = "mt-1 h-8 w-full min-w-0 rounded-md border border-[#c9c8c2] bg-white px-2 text-xs text-[#202329] outline-none transition focus:border-[#55aac9] focus:ring-2 focus:ring-[#55aac9]/25";
const optionClassName = "rounded-md border border-[#deddd7] bg-white px-2.5 py-1.5 text-xs text-[#40454d] transition hover:border-[#55aac9] hover:bg-[#f7fbfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/40";

function valueLabel(value: string): string {
  const labels: Record<string, string> = {
    people: "Participants",
    participants: "Participants",
    screenshare: "Screen share",
    "soft-grid": "Soft grid",
    "soft-dots": "Soft dots",
    none: "None",
  };

  return labels[value] ?? value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateLabel(state: PreviewState): string {
  return valueLabel(state);
}

function SelectField<T extends string | number>({ label, value, options, onChange, format = (option) => valueLabel(String(option)) }: { readonly label: string; readonly value: T; readonly options: readonly T[]; readonly onChange: (value: T) => void; readonly format?: (value: T) => string }) {
  return (
    <label className="min-w-0 text-[11px] font-semibold text-[#555b65]">
      <span>{label}</span>
      <select
        className={fieldClassName}
        value={String(value)}
        aria-label={label}
        onChange={(event) => {
          const next = options.find((option) => String(option) === event.target.value);
          if (next !== undefined) onChange(next);
        }}
      >
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {format(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded-md border border-[#deddd7] bg-white px-2.5 py-1.5 text-xs text-[#40454d]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} aria-label={label} className="h-4 w-4 accent-[#315f72]" onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function StateLinks({ search, onChange }: PreviewGalleryToolbarProps) {
  const linkFor = (view: PreviewSearch["view"], state: PreviewState) => createPreviewHref(patchPreviewSearch(search, { view, state }));
  const selectState = (event: MouseEvent<HTMLAnchorElement>, view: PreviewSearch["view"], state: PreviewState) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onChange({ view, state });
  };

  return (
    <fieldset className="border-0 p-0">
      <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d727b]">Direct state links</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <h3 className="text-[11px] font-semibold text-[#555b65]">Entrance</h3>
          <nav aria-label="Entrance states" className="mt-1.5 flex flex-wrap gap-1.5">
            {ENTRANCE_STATES.map((state) => (
              <a key={state} href={linkFor("entrance", state)} aria-current={search.view === "entrance" && search.state === state ? "page" : undefined} className={optionClassName} onClick={(event) => selectState(event, "entrance", state)}>
                {stateLabel(state)}
              </a>
            ))}
          </nav>
        </div>
        <div>
          <h3 className="text-[11px] font-semibold text-[#555b65]">Space</h3>
          <nav aria-label="Space states" className="mt-1.5 flex flex-wrap gap-1.5">
            {SPACE_STATES.map((state) => (
              <a key={state} href={linkFor("space", state)} aria-current={search.view === "space" && search.state === state ? "page" : undefined} className={optionClassName} onClick={(event) => selectState(event, "space", state)}>
                {stateLabel(state)}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </fieldset>
  );
}

export function PreviewGalleryToolbar({ search, onChange }: PreviewGalleryToolbarProps) {
  const controlsId = useId();
  const isVisible = search.chrome === "visible";
  const stateOptions = search.view === "entrance" ? ENTRANCE_STATES : SPACE_STATES;

  if (!isVisible) {
    return (
      <div className="fixed inset-x-2 bottom-24 z-[65] flex justify-start sm:left-4 sm:right-auto sm:bottom-4">
        <Button type="button" variant="outline" size="sm" className="border-[#c9c8c2] bg-[#fbfaf7] text-[#202329] shadow-md hover:bg-white" aria-controls={controlsId} aria-expanded={false} onClick={() => onChange({ chrome: "visible" })}>
          Show preview controls
        </Button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-2 bottom-24 z-[65] flex justify-start sm:left-4 sm:right-auto sm:bottom-4">
      <section id={controlsId} aria-label="Preview controls" className="pointer-events-auto max-h-[min(82vh,680px)] w-[min(370px,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-xl border border-[#c9c8c2] bg-[#fbfaf7]/95 p-3 shadow-[0_20px_60px_rgba(12,14,18,0.18)] backdrop-blur">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#202329]">Preview controls</h2>
            <p className="mt-0.5 text-[11px] text-[#858a92]">Open a focused state or tune the Space.</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Hide preview controls" aria-controls={controlsId} aria-expanded={true} onClick={() => onChange({ chrome: "hidden" })}>
            <span aria-hidden="true">×</span>
          </Button>
        </header>

        <div className="mt-3 space-y-3">
          <StateLinks search={search} onChange={onChange} />

          <fieldset className="border-0 p-0">
            <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d727b]">View and state</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <SelectField label="View" value={search.view} options={PREVIEW_VIEWS} onChange={(view) => onChange({ view, state: view === "entrance" ? ENTRANCE_STATES[0] : SPACE_STATES[0] })} />
              <SelectField label="State" value={search.state} options={stateOptions} format={stateLabel} onChange={(state) => onChange({ state })} />
            </div>
          </fieldset>

          <fieldset className="border-0 p-0">
            <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d727b]">Space data</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <SelectField label="Participants" value={search.participants} options={PREVIEW_PARTICIPANT_COUNTS} format={(count) => `${count} Participant${count === 1 ? "" : "s"}`} onChange={(participants) => onChange({ participants })} />
              <SelectField label="Chat data" value={search.chat} options={PREVIEW_CHAT_STATES} onChange={(chat) => onChange({ chat })} />
              <SelectField label="Stage" value={search.stage} options={PREVIEW_STAGES} onChange={(stage) => onChange({ stage })} />
              <SelectField label="Panel" value={search.panel} options={PREVIEW_PANELS} format={valueLabel} onChange={(panel) => onChange({ panel })} />
              <SelectField label="Dialog" value={search.dialog} options={PREVIEW_DIALOGS} onChange={(dialog) => onChange({ dialog })} />
              <SelectField label="Layout" value={search.layout} options={PREVIEW_LAYOUTS} onChange={(layout) => onChange({ layout })} />
            </div>
          </fieldset>

          <fieldset className="border-0 p-0">
            <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d727b]">Appearance and signals</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <SelectField label="Palette" value={search.palette} options={PREVIEW_PALETTES} onChange={(palette) => onChange({ palette })} />
              <SelectField label="Texture" value={search.texture} options={PREVIEW_TEXTURES} onChange={(texture) => onChange({ texture })} />
              <SelectField label="Toast" value={search.toast} options={PREVIEW_TOASTS} onChange={(toast) => onChange({ toast })} />
            </div>
          </fieldset>

          <fieldset className="border-0 p-0">
            <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d727b]">Participant media</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <ToggleField label="Microphone" checked={search.mic} onChange={(mic) => onChange({ mic })} />
              <ToggleField label="Camera" checked={search.camera} onChange={(camera) => onChange({ camera })} />
              <ToggleField label="Raised hand" checked={search.hand} onChange={(hand) => onChange({ hand })} />
            </div>
          </fieldset>
        </div>
      </section>
    </div>
  );
}
