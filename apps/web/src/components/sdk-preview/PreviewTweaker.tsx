import { useState } from "react";
import { THEME_PALETTES, THEME_TEXTURES, type ThemePalette, type ThemeTexture } from "@q9labsai/chalk-react/components";

import { Cancel01Icon, Settings01Icon } from "../../../../../sdks/typescript/react/src/utils/icons";
import type { Toast } from "../../../../../sdks/typescript/react/src/components/toast-stack/ToastStack";

interface PreviewTweakerProps {
  readonly palette: ThemePalette;
  readonly texture: ThemeTexture;
  readonly onPaletteChange: (palette: ThemePalette) => void;
  readonly onTextureChange: (texture: ThemeTexture) => void;
  readonly onNotify: (type: NonNullable<Toast["type"]>) => void;
  readonly onShowPeople: () => void;
  readonly onShowChat: () => void;
  readonly onShowScreenShare: () => void;
  readonly onShowWhiteboard: () => void;
  readonly onShowMeetingInfo: () => void;
  readonly onShowSettings: () => void;
  readonly onToggleHand: () => void;
}

const triggerClassName = "rounded-[7px] border border-[#deddd7] bg-white px-3 py-2 text-left text-xs font-medium text-[#202329] transition hover:border-[#b7b6b0] hover:bg-[#f7f6f2]";
const fieldClassName = "mt-1 h-9 w-full rounded-[7px] border border-[#c9c8c2] bg-white px-2.5 text-xs text-[#202329] outline-none focus:border-[#55aac9]";

export function PreviewTweaker(props: PreviewTweakerProps) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="fixed bottom-24 left-3 z-[65] sm:bottom-5 sm:left-5">
      {isOpen ? (
        <section className="mb-2 w-[min(280px,calc(100vw-24px))] rounded-[12px] border border-[#c9c8c2] bg-[#fbfaf7] p-3 shadow-[0_20px_60px_rgba(12,14,18,0.16)]" aria-label="Preview state controls">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Preview states</h2>
              <p className="mt-0.5 text-[11px] text-[#858a92]">Trigger polished UI states</p>
            </div>
            <button type="button" onClick={() => setIsOpen(false)} className="grid h-8 w-8 place-items-center rounded-[6px] text-[#6d727b] hover:bg-[#eeede8]" aria-label="Close preview controls">
              <Cancel01Icon size={16} />
            </button>
          </header>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <label className="text-[11px] font-medium text-[#555b65]">
              Palette
              <select className={fieldClassName} value={props.palette} onChange={(event) => props.onPaletteChange(event.target.value as ThemePalette)}>
                {THEME_PALETTES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-[#555b65]">
              Texture
              <select className={fieldClassName} value={props.texture} onChange={(event) => props.onTextureChange(event.target.value as ThemeTexture)}>
                {THEME_TEXTURES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={triggerClassName} onClick={props.onShowPeople}>
              People
            </button>
            <button type="button" className={triggerClassName} onClick={props.onShowChat}>
              Chat
            </button>
            <button type="button" className={triggerClassName} onClick={props.onShowScreenShare}>
              Screen share
            </button>
            <button type="button" className={triggerClassName} onClick={props.onShowWhiteboard}>
              Whiteboard
            </button>
            <button type="button" className={triggerClassName} onClick={props.onShowMeetingInfo}>
              Meeting info
            </button>
            <button type="button" className={triggerClassName} onClick={props.onShowSettings}>
              Settings
            </button>
            <button type="button" className={triggerClassName} onClick={props.onToggleHand}>
              Raised hand
            </button>
          </div>
          <p className="mb-2 mt-4 text-[11px] font-medium text-[#6d727b]">Notifications</p>
          <div className="grid grid-cols-4 gap-1.5">
            {(["info", "success", "warning", "error"] as const).map((type) => (
              <button key={type} type="button" onClick={() => props.onNotify(type)} className="rounded-[6px] bg-[#eeede8] px-1 py-2 text-[10px] capitalize text-[#555b65] hover:bg-[#e5e4df]">
                {type}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <button type="button" onClick={() => setIsOpen((value) => !value)} className="flex h-10 items-center gap-2 rounded-[9px] border border-[#c9c8c2] bg-[#fbfaf7] px-3 text-xs font-semibold text-[#202329] shadow-[0_8px_24px_rgba(12,14,18,0.1)] transition hover:bg-white" aria-expanded={isOpen}>
        <Settings01Icon size={15} /> Preview
      </button>
    </div>
  );
}
