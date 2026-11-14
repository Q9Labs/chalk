import { useState } from "react";
import { type TranscriptLanguage } from "@chalk/transcript-language";

import type { RecordingRenderSettingsDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { LanguagePicker } from "./LanguagePicker";
import { Seg, useToast } from "./kit";
import { rememberLanguage } from "./language-choice";

type RenderMode = RecordingRenderSettingsDTO["recordingRenderMode"];
const RENDER_MODES: readonly (readonly [RenderMode, string])[] = [
  ["on_demand", "On demand"],
  ["automatic", "Automatic"],
];

/** One setting that saves on change: `save` runs the write and toasts its message or its error, and ignores a second change while one is saving. */
function useSetting() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  async function save(write: () => Promise<string>) {
    if (saving) return;
    setSaving(true);
    try {
      toast(await write());
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }
  return [saving, save] as const;
}

/** Account defaults for calls. Each control saves when it changes, and puts the old value back if the save fails. */
export function CallsPanel({ renderMode, language, onRenderMode, onLanguage }: { readonly renderMode: RenderMode; readonly language: TranscriptLanguage; readonly onRenderMode: (mode: RenderMode) => void; readonly onLanguage: (language: TranscriptLanguage) => void }) {
  const [, saveMode] = useSetting();
  const [savingLanguage, saveLanguage] = useSetting();

  const changeMode = (mode: RenderMode) =>
    mode === renderMode
      ? undefined
      : saveMode(async () => {
          const saved = await act("developer", { action: "set-recording-render-mode", mode });
          onRenderMode(saved.recordingRenderMode);
          return "Recording settings saved";
        });
  const changeLanguage = (next: TranscriptLanguage | null) =>
    next === null || next === language
      ? undefined
      : saveLanguage(async () => {
          const saved = await act("developer", { action: "set-default-transcript-language", transcriptLanguage: next });
          if (next !== "auto") rememberLanguage(next);
          onLanguage(saved.transcriptLanguage);
          return "Transcript language saved";
        });

  return (
    <section className="panel card" id="calls" aria-labelledby="calls-title">
      <div className="ph">
        <Icon name="rec" size={18} />
        <div>
          <h2 id="calls-title">Calls</h2>
          <div className="sub">Defaults for every call in this account.</div>
        </div>
      </div>
      <div className="set" id="recording-videos">
        <span className="tile">
          <Icon name="film" size={18} />
        </span>
        <div>
          <b id="recording-render-mode-label">Recording videos</b>
          <p>On demand makes an MP4 when you request a video. Automatic makes one after each recorded call ends.</p>
        </div>
        <Seg labelledBy="recording-render-mode-label" options={RENDER_MODES} value={renderMode} onChange={(mode) => void changeMode(mode)} />
      </div>
      <div className="set" id="transcript-language">
        <span className="tile">
          <Icon name="file" size={18} />
        </span>
        <div>
          <b id="tenant-transcript-language-label">Transcript language</b>
          <p id="tenant-transcript-language-help">The default for new transcripts, unless a call has its own setting.</p>
        </div>
        <LanguagePicker id="tenant-transcript-language" labelledBy="tenant-transcript-language-label" describedBy="tenant-transcript-language-help" value={language} loading={savingLanguage} loadingLabel="Saving…" onChange={(next) => void changeLanguage(next)} />
      </div>
      <div className="foot">
        <Icon name="check" size={14} />
        Changes save when you make them.
      </div>
    </section>
  );
}
