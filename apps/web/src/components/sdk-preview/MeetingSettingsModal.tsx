import { useState } from "react";

import { ArrowDown01Icon, Cancel01Icon, Microphone01Icon, Settings01Icon, Video01Icon, VolumeHighIcon } from "../../../../../sdks/typescript/react/src/utils/icons";

interface MeetingSettingsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

type Section = "audio" | "video" | "general";

const sectionItems = [
  { id: "audio" as const, label: "Audio", icon: Microphone01Icon },
  { id: "video" as const, label: "Video", icon: Video01Icon },
  { id: "general" as const, label: "General", icon: Settings01Icon },
];

function DeviceSelect({ label, value, options }: { readonly label: string; readonly value: string; readonly options: readonly string[] }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[#202329]">{label}</span>
      <span className="relative mt-2 block">
        <select defaultValue={value} className="h-11 w-full appearance-none rounded-[8px] border border-[#c9c8c2] bg-white px-3 pr-10 text-sm text-[#202329] outline-none transition focus:border-[#74b7cf]">
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
        <ArrowDown01Icon size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#6d727b]" />
      </span>
    </label>
  );
}

function ToggleRow({ label, description, defaultChecked = true }: { readonly label: string; readonly description: string; readonly defaultChecked?: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <button type="button" onClick={() => setChecked((value) => !value)} className="flex w-full items-center justify-between gap-5 border-t border-[#e5e4df] py-4 text-left first:border-t-0" aria-pressed={checked}>
      <span>
        <span className="block text-sm font-medium text-[#202329]">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-[#6d727b]">{description}</span>
      </span>
      <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${checked ? "bg-[#55aac9]" : "bg-[#c9c8c2]"}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition ${checked ? "left-5" : "left-1"}`} />
      </span>
    </button>
  );
}

export function MeetingSettingsModal({ isOpen, onClose }: MeetingSettingsModalProps) {
  const [section, setSection] = useState<Section>("audio");
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-[#0c0e12]/20 p-4 backdrop-blur-[1px]" onMouseDown={onClose}>
      <section
        className="flex max-h-[min(680px,calc(100dvh-32px))] w-full max-w-[720px] overflow-hidden rounded-[14px] border border-[#c9c8c2] bg-[#fbfaf7] shadow-[0_28px_80px_rgba(12,14,18,0.2)]"
        role="dialog"
        aria-modal="true"
        aria-label="Meeting settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="hidden w-44 shrink-0 border-r border-[#deddd7] bg-[#f4f3ef] p-3 sm:block" aria-label="Settings sections">
          <p className="px-2 pb-3 pt-1 text-sm font-semibold">Settings</p>
          {sectionItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`mb-1 flex h-10 w-full items-center gap-2.5 rounded-[8px] px-3 text-sm font-medium transition ${section === item.id ? "bg-white text-[#202329] shadow-[0_1px_2px_rgba(12,14,18,0.06)]" : "text-[#6d727b] hover:text-[#202329]"}`}
              aria-current={section === item.id ? "page" : undefined}
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#deddd7] bg-[#fbfaf7] px-5 py-4 sm:px-6">
            <div>
              <h2 className="text-lg font-semibold capitalize tracking-[-0.02em]">{section}</h2>
              <p className="mt-0.5 text-xs text-[#6d727b]">Changes apply to this device.</p>
            </div>
            <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-[8px] text-[#6d727b] transition hover:bg-[#eeede8] hover:text-[#202329]" aria-label="Close settings">
              <Cancel01Icon size={19} />
            </button>
          </header>

          <div className="flex gap-1 overflow-x-auto border-b border-[#deddd7] px-4 py-2 sm:hidden">
            {sectionItems.map((item) => (
              <button key={item.id} type="button" onClick={() => setSection(item.id)} className={`rounded-[7px] px-3 py-2 text-sm ${section === item.id ? "bg-[#eeede8] font-semibold" : "text-[#6d727b]"}`}>
                {item.label}
              </button>
            ))}
          </div>

          <div className="space-y-6 p-5 sm:p-6">
            {section === "audio" ? (
              <>
                <div className="grid gap-5 sm:grid-cols-2">
                  <DeviceSelect label="Microphone" value="MacBook Air Microphone" options={["MacBook Air Microphone", "Studio Display Microphone", "AirPods Pro"]} />
                  <DeviceSelect label="Speaker" value="MacBook Air Speakers" options={["MacBook Air Speakers", "Studio Display Speakers", "AirPods Pro"]} />
                </div>
                <div className="rounded-[10px] border border-[#deddd7] bg-white px-4">
                  <ToggleRow label="Noise suppression" description="Reduce fans, keyboard noise, and room echo." />
                  <ToggleRow label="Original sound" description="Preserve music and high-frequency audio." defaultChecked={false} />
                </div>
                <div className="flex items-center gap-3 rounded-[10px] border border-[#deddd7] bg-white p-4">
                  <VolumeHighIcon size={18} className="text-[#6d727b]" />
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e5e4df]">
                    <div className="h-full w-[68%] rounded-full bg-[#55aac9]" />
                  </div>
                  <span className="font-mono text-xs text-[#6d727b]">68%</span>
                </div>
              </>
            ) : null}

            {section === "video" ? (
              <>
                <DeviceSelect label="Camera" value="MacBook Air Camera" options={["MacBook Air Camera", "Iriun Camera", "OBS Virtual Camera"]} />
                <div className="aspect-video rounded-[10px] border border-[#9dcfe1] bg-[linear-gradient(135deg,#eaf7fb,#edf6eb)] p-5">
                  <div className="grid h-full place-items-center rounded-[7px] border border-white/70 bg-white/30 text-sm text-[#49645d]">Camera preview</div>
                </div>
                <div className="rounded-[10px] border border-[#deddd7] bg-white px-4">
                  <ToggleRow label="Mirror my video" description="Only changes your local preview." />
                  <ToggleRow label="High definition" description="Use 1080p when bandwidth allows." />
                </div>
              </>
            ) : null}

            {section === "general" ? (
              <div className="rounded-[10px] border border-[#deddd7] bg-white px-4">
                <ToggleRow label="Meeting notifications" description="Show joins, raised hands, and connection changes." />
                <ToggleRow label="Live captions" description="Start captions automatically when you join." defaultChecked={false} />
                <ToggleRow label="Compact participant labels" description="Keep more of each video tile visible." />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
