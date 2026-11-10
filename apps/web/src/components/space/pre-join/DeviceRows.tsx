import type { PreJoinDevices } from "@q9labsai/chalk-react";
import { ArrowDown01Icon, cn, Microphone01Icon, Tick01Icon, Video01Icon, VolumeHighIcon } from "@q9labsai/chalk-react/utils";
import { useState, type ReactNode } from "react";
import { BottomSheet, useDismiss } from "./Overlay";
import { LevelMeter } from "./LevelMeter";

type Kind = "microphone" | "camera" | "speaker";
type RowView = { readonly kind: Kind; readonly caption: string; readonly value: string; readonly tone: "normal" | "warn" | "muted"; readonly help?: string; readonly trailing?: ReactNode };

const FALLBACK: Record<Kind, string> = { microphone: "Microphone", camera: "Camera", speaker: "System default speaker" };
const CAPTION: Record<Kind, string> = { microphone: "Microphone", camera: "Camera", speaker: "Speaker" };
const LEAD: Record<Kind, typeof Microphone01Icon> = { microphone: Microphone01Icon, camera: Video01Icon, speaker: VolumeHighIcon };

const nameOf = (list: readonly MediaDeviceInfo[], deviceId: string | undefined, kind: Kind) => list.find((device) => device.deviceId === deviceId)?.label || FALLBACK[kind];

function listFor(devices: PreJoinDevices, kind: Kind) {
  if (kind === "microphone") return { list: devices.microphones, selected: devices.microphoneId, select: devices.selectMicrophone };
  if (kind === "camera") return { list: devices.cameras, selected: devices.cameraId, select: devices.selectCamera };
  return { list: devices.speakers, selected: devices.speakerId, select: devices.selectSpeaker };
}

/** What each row says, from the devices' state: the picked device, "Off", or why nothing can be picked. */
function rowViews(devices: PreJoinDevices, compact = false): readonly RowView[] {
  const granted = devices.access === "granted";
  const input = (kind: "microphone" | "camera"): RowView => {
    const missing = kind === "microphone" ? devices.microphoneMissing : devices.cameraMissing;
    const on = kind === "microphone" ? devices.microphoneOn : devices.cameraOn;
    const { list, selected } = listFor(devices, kind);
    if (!granted) return { kind, caption: CAPTION[kind], value: "Allow access to choose", tone: "muted" };
    if (missing) return { kind, caption: CAPTION[kind], value: `No ${kind} found`, tone: "warn", help: kind === "microphone" ? "Plug one in and Chalk switches to it. You can still listen and be seen." : "Plug one in and Chalk switches to it. You can still listen and join." };
    const name = nameOf(list, selected, kind);
    if (!on) return { kind, caption: CAPTION[kind], value: name, tone: "normal", trailing: <span className="text-(length:--type-body-sm) text-[var(--chalk-muted-text)]">Off</span> };
    return { kind, caption: CAPTION[kind], value: name, tone: "normal", trailing: kind === "microphone" ? <LevelMeter level={devices.microphoneLevel} small={compact} /> : undefined };
  };
  const speaker: RowView = { kind: "speaker", caption: CAPTION.speaker, value: nameOf(devices.speakers, devices.speakerId, "speaker"), tone: "normal" };
  return [input("microphone"), input("camera"), ...(devices.canChooseSpeaker ? [speaker] : [])];
}

function DeviceList({ devices, kind, onPick }: { readonly devices: PreJoinDevices; readonly kind: Kind; readonly onPick: () => void }) {
  const { list, selected, select } = listFor(devices, kind);
  return (
    <div role="listbox" aria-label={CAPTION[kind]} className="absolute inset-x-0 bottom-full z-20 mb-2 grid rounded-2xl border border-[var(--chalk-line-strong)] bg-[var(--chalk-popover)] p-2">
      <p className="px-3 pb-1 pt-2 text-(length:--type-caption) font-semibold text-[var(--chalk-muted-text)]">{CAPTION[kind]}</p>
      {list.length ? (
        list.map((device) => (
          <button
            key={device.deviceId}
            type="button"
            role="option"
            aria-selected={selected === device.deviceId}
            onClick={() => {
              select(device.deviceId);
              onPick();
            }}
            className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-left text-(length:--type-body) outline-none hover:bg-[var(--chalk-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
          >
            <span className="grid w-[18px] flex-none place-items-center">{selected === device.deviceId ? <Tick01Icon size={18} aria-hidden="true" /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{device.label || FALLBACK[kind]}</span>
            {kind === "microphone" && selected === device.deviceId && devices.microphoneOn ? <LevelMeter level={devices.microphoneLevel} small /> : null}
          </button>
        ))
      ) : (
        <p className="px-3 py-3 text-(length:--type-body) text-[var(--chalk-muted-text)]">No devices found</p>
      )}
    </div>
  );
}

const rowClass = "flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left outline-none hover:bg-[var(--chalk-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";

function RowBody({ view, reserve = false }: { readonly view: RowView; readonly reserve?: boolean }) {
  const Lead = LEAD[view.kind];
  return (
    <>
      <span className="grid w-[18px] flex-none place-items-center text-[var(--chalk-muted-text)]">
        <Lead size={18} aria-hidden="true" />
      </span>
      <span className={cn("grid min-w-0 flex-1 gap-px", view.tone === "muted" && "opacity-60", reserve && "mr-24")}>
        <small className="text-(length:--type-caption) leading-snug text-[var(--chalk-muted-text)]">{view.caption}</small>
        <span className={cn("truncate text-(length:--type-body) leading-snug", view.tone === "warn" && "text-[var(--chalk-warning)]", view.tone === "muted" && "text-[var(--chalk-muted-text)]")}>{view.value}</span>
      </span>
      {view.trailing}
      <ArrowDown01Icon size={16} aria-hidden="true" className="flex-none text-[var(--chalk-muted-text)]" />
    </>
  );
}

function DeviceRow({ view, devices, onNeedAccess, first }: { readonly view: RowView; readonly devices: PreJoinDevices; readonly onNeedAccess: () => void; readonly first: boolean }) {
  const [open, setOpen] = useState(false);
  const container = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const granted = devices.access === "granted";
  const pickable = granted || view.kind === "speaker";
  return (
    <div ref={container} className={cn("relative", !first && "border-t border-[var(--chalk-line)]")}>
      <button type="button" className={rowClass} aria-label={`${view.caption}: ${view.value}`} aria-haspopup={pickable ? "listbox" : undefined} aria-expanded={pickable ? open : undefined} onClick={pickable ? () => setOpen(!open) : onNeedAccess}>
        <RowBody view={view} reserve={view.kind === "speaker"} />
      </button>
      {open ? <DeviceList devices={devices} kind={view.kind} onPick={() => setOpen(false)} /> : null}
      {view.kind === "speaker" ? (
        <button
          type="button"
          onClick={() => void devices.testSpeaker()}
          className={cn("absolute right-10 top-1/2 inline-flex h-8 -translate-y-1/2 items-center gap-1.5 rounded-full bg-[var(--chalk-hover)] px-3 text-(length:--type-caption) font-medium", devices.speakerTesting && "text-[var(--chalk-accent)]")}
        >
          <VolumeHighIcon size={14} aria-hidden="true" />
          Test
        </button>
      ) : null}
      {view.help ? <p className="pb-3 pl-11 pr-3 text-(length:--type-caption) leading-snug text-[var(--chalk-muted-text)]">{view.help}</p> : null}
    </div>
  );
}

/** One grouped card: microphone with its level, camera, and speaker with a test tone. */
export function DeviceRows({ devices, locked, onNeedAccess }: { readonly devices: PreJoinDevices; readonly locked: boolean; readonly onNeedAccess: () => void }) {
  return (
    <div className={cn("grid rounded-2xl bg-[var(--chalk-raised)] p-1 ring-1 ring-[var(--chalk-line)]", locked && "pointer-events-none opacity-55")} aria-label="Devices" role="group">
      {rowViews(devices).map((view, index) => (
        <DeviceRow key={view.kind} view={view} devices={devices} onNeedAccess={onNeedAccess} first={index === 0} />
      ))}
    </div>
  );
}

/** On a phone the three pickers share one row that opens a sheet. */
export function DevicesSheetRow({ devices, locked, onNeedAccess }: { readonly devices: PreJoinDevices; readonly locked: boolean; readonly onNeedAccess: () => void }) {
  const [open, setOpen] = useState(false);
  const granted = devices.access === "granted";
  const [microphone] = rowViews(devices, true);
  if (!microphone) return null;
  const summary: RowView = { ...microphone, kind: "microphone", caption: "Devices", help: undefined };
  return (
    <div className={cn("rounded-2xl bg-[var(--chalk-raised)] p-1 ring-1 ring-[var(--chalk-line)]", locked && "pointer-events-none opacity-55")}>
      <button type="button" className={rowClass} aria-haspopup="dialog" onClick={granted ? () => setOpen(true) : onNeedAccess}>
        <RowBody view={summary} />
      </button>
      {open ? (
        <BottomSheet label="Devices" onClose={() => setOpen(false)}>
          <div className="grid gap-3 px-3 pb-8">
            {(["microphone", "camera", ...(devices.canChooseSpeaker ? (["speaker"] as const) : [])] as const).map((kind) => {
              const { list, selected, select } = listFor(devices, kind);
              return (
                <div key={kind} role="radiogroup" aria-label={CAPTION[kind]} className="grid">
                  <p className="px-3 pb-1 pt-2 text-(length:--type-caption) font-semibold text-[var(--chalk-muted-text)]">{CAPTION[kind]}</p>
                  {list.map((device) => (
                    <button key={device.deviceId} type="button" role="radio" aria-checked={selected === device.deviceId} onClick={() => select(device.deviceId)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-left text-(length:--type-body) hover:bg-[var(--chalk-hover)]">
                      <span className="grid w-[18px] flex-none place-items-center">{selected === device.deviceId ? <Tick01Icon size={18} aria-hidden="true" /> : null}</span>
                      <span className="min-w-0 flex-1 truncate">{device.label || FALLBACK[kind]}</span>
                      {kind === "microphone" && selected === device.deviceId && devices.microphoneOn ? <LevelMeter level={devices.microphoneLevel} small /> : null}
                    </button>
                  ))}
                </div>
              );
            })}
            {devices.canChooseSpeaker ? (
              <button type="button" onClick={() => void devices.testSpeaker()} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--chalk-hover)] text-(length:--type-body) font-medium">
                <VolumeHighIcon size={16} aria-hidden="true" />
                Test speaker
              </button>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
