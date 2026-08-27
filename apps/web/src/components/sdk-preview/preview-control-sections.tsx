import type { MouseEvent } from "react";

import { ChipGroup, Field, SelectField, SwitchField, ToggleChip } from "./preview-control-fields";
import { featureLabel, paletteLabel, paletteMode, skinDescription, skinLabel, stateLabel, textureDescription, textureLabel, valueLabel } from "./preview-labels";
import {
  createPreviewHref,
  ENTRANCE_STATES,
  patchPreviewSearch,
  PREVIEW_ACTIVE_SPEAKERS,
  PREVIEW_ADMISSION_QUEUES,
  PREVIEW_CAPABILITY_PRESETS,
  PREVIEW_CHAT_STATES,
  PREVIEW_DIALOGS,
  PREVIEW_FEATURE_KEYS,
  PREVIEW_INCOMING_MEDIA_REQUESTS,
  PREVIEW_LAYOUTS,
  PREVIEW_MEDIA_STATES,
  PREVIEW_PANELS,
  PREVIEW_PARTICIPANT_COUNTS,
  PREVIEW_PALETTES,
  PREVIEW_ROLE_PRESETS,
  PREVIEW_SCREEN_SHARES,
  PREVIEW_SKINS,
  PREVIEW_STAGES,
  PREVIEW_TEXTURES,
  PREVIEW_TOASTS,
  SPACE_STATES,
  type PreviewSearch,
  type PreviewSearchPatch,
  type PreviewState,
} from "./preview-state";

export interface PreviewControlSectionProps {
  readonly search: PreviewSearch;
  readonly onChange: (patch: PreviewSearchPatch) => void;
}

const stateLinkClassName =
  "group inline-flex h-8 items-center rounded-lg border border-[#d9d8d2] bg-white px-3 text-[13px] font-medium leading-none no-underline transition-colors hover:border-[#55aac9] hover:bg-[#f7fbfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/60 aria-[current=page]:border-[#202329] aria-[current=page]:bg-[#202329]";
// The app's global `a { color: inherit }` is unlayered and outranks Tailwind utilities on the anchor itself, so the ink lives on an inner span.
const stateLinkLabelClassName = "text-[#40454d] group-aria-[current=page]:text-white";

function StateLinks({ search, onChange, view, states, title }: PreviewControlSectionProps & { readonly view: PreviewSearch["view"]; readonly states: readonly PreviewState[]; readonly title: string }) {
  const selectState = (event: MouseEvent<HTMLAnchorElement>, state: PreviewState) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onChange({ view, state });
  };

  return (
    <Field label={title} hint={search.view === view ? "current view" : undefined}>
      <nav aria-label={`${title} states`} className="flex flex-wrap gap-1.5">
        {states.map((state) => (
          <a key={state} href={createPreviewHref(patchPreviewSearch(search, { view, state }))} aria-current={search.view === view && search.state === state ? "page" : undefined} className={stateLinkClassName} onClick={(event) => selectState(event, state)}>
            <span className={stateLinkLabelClassName}>{stateLabel(state)}</span>
          </a>
        ))}
      </nav>
    </Field>
  );
}

export function StatesSection(props: PreviewControlSectionProps) {
  return (
    <div className="space-y-5">
      <StateLinks {...props} view="entrance" states={ENTRANCE_STATES} title="Entrance" />
      <StateLinks {...props} view="space" states={SPACE_STATES} title="Space" />
      <p className="text-xs leading-5 text-[#858a92]">
        Each chip is a real link: ⌘-click opens that state in a new tab. Use <kbd className="rounded border border-[#d9d8d2] bg-white px-1 font-mono text-[11px]">[</kbd> and <kbd className="rounded border border-[#d9d8d2] bg-white px-1 font-mono text-[11px]">]</kbd> to step through states.
      </p>
    </div>
  );
}

export function SpaceSection({ search, onChange }: PreviewControlSectionProps) {
  return (
    <div className="space-y-5">
      {search.view === "entrance" ? <p className="rounded-lg border border-dashed border-[#d9d8d2] px-3 py-2 text-xs leading-5 text-[#6d727b]">These apply once a Space state is open. Pick one under States.</p> : null}
      <ChipGroup label="Participants" value={search.participants} options={PREVIEW_PARTICIPANT_COUNTS} format={(count) => String(count)} onChange={(participants) => onChange({ participants })} />
      <ChipGroup label="Layout" value={search.layout} options={PREVIEW_LAYOUTS} onChange={(layout) => onChange({ layout })} />
      <ChipGroup label="Stage" value={search.stage} options={PREVIEW_STAGES} onChange={(stage) => onChange({ stage })} />
      <SwitchField label="Stage background" checked={search.stageBackground} onChange={(stageBackground) => onChange({ stageBackground })} />
      <ChipGroup label="Panel" value={search.panel} options={PREVIEW_PANELS} format={valueLabel} onChange={(panel) => onChange({ panel })} />
      <ChipGroup label="Dialog" value={search.dialog} options={PREVIEW_DIALOGS} onChange={(dialog) => onChange({ dialog })} />
      <ChipGroup label="Toast" value={search.toast} options={PREVIEW_TOASTS} onChange={(toast) => onChange({ toast })} />
      <ChipGroup label="Chat data" value={search.chat} options={PREVIEW_CHAT_STATES} onChange={(chat) => onChange({ chat })} />
      <ChipGroup label="Screen share" value={search.screenShare} options={PREVIEW_SCREEN_SHARES} format={valueLabel} onChange={(screenShare) => onChange({ screenShare })} />
      <ChipGroup label="Incoming media request" value={search.incomingMediaRequest} options={PREVIEW_INCOMING_MEDIA_REQUESTS} format={valueLabel} onChange={(incomingMediaRequest) => onChange({ incomingMediaRequest })} />
      <ChipGroup label="Admission queue" value={search.admissionQueue} options={PREVIEW_ADMISSION_QUEUES} onChange={(admissionQueue) => onChange({ admissionQueue })} />
      <SelectField label="Active speaker" value={search.activeSpeaker} options={PREVIEW_ACTIVE_SPEAKERS} format={valueLabel} onChange={(activeSpeaker) => onChange({ activeSpeaker })} />
    </div>
  );
}

export function MediaSection({ search, onChange }: PreviewControlSectionProps) {
  return (
    <div className="space-y-5">
      <ChipGroup label="Microphone" value={search.mic} options={PREVIEW_MEDIA_STATES} format={valueLabel} onChange={(mic) => onChange({ mic })} />
      <ChipGroup label="Camera" value={search.camera} options={PREVIEW_MEDIA_STATES} format={valueLabel} onChange={(camera) => onChange({ camera })} />
      <SwitchField label="Raised hand" checked={search.hand} onChange={(hand) => onChange({ hand })} />
    </div>
  );
}

export function AccessSection({ search, onChange }: PreviewControlSectionProps) {
  const enabledCount = PREVIEW_FEATURE_KEYS.filter((feature) => search.features[feature]).length;
  return (
    <div className="space-y-5">
      <ChipGroup label="Role" value={search.role} options={PREVIEW_ROLE_PRESETS} onChange={(role) => onChange({ role })} />
      <ChipGroup label="Capability" value={search.capability} options={PREVIEW_CAPABILITY_PRESETS} onChange={(capability) => onChange({ capability })} />
      <SwitchField label="Diagnostics" hint="adds the diagnostics action" checked={search.diagnostics} onChange={(diagnostics) => onChange({ diagnostics })} />
      <Field label="Features" hint={`${enabledCount} of ${PREVIEW_FEATURE_KEYS.length} on`}>
        <div className="flex flex-wrap gap-1.5">
          {PREVIEW_FEATURE_KEYS.map((feature) => (
            <ToggleChip key={feature} label={valueLabel(feature)} ariaLabel={featureLabel(feature)} pressed={search.features[feature]} onChange={(checked) => onChange({ features: { [feature]: checked } })} />
          ))}
        </div>
      </Field>
    </div>
  );
}

export function LookSection({ search, onChange }: PreviewControlSectionProps) {
  return (
    <div className="space-y-5">
      <ChipGroup label="Skin" value={search.skin} options={PREVIEW_SKINS} format={skinLabel} describe={skinDescription} onChange={(skin) => onChange({ skin })} />
      <SelectField label="Palette" value={search.palette} options={PREVIEW_PALETTES} format={paletteLabel} groupBy={(palette) => (paletteMode(palette) === "dark" ? "Dark" : "Light")} onChange={(palette) => onChange({ palette })} />
      <ChipGroup label="Texture" value={search.texture} options={PREVIEW_TEXTURES} format={textureLabel} describe={textureDescription} onChange={(texture) => onChange({ texture })} />
    </div>
  );
}
