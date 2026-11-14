import { useState } from "react";

import { act, errorMessage } from "../../lib/dashboard/client";
import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { displayLink } from "../../lib/dashboard/format";
import { LanguagePicker } from "./LanguagePicker";
import { rememberLanguage, type NewCallLanguage } from "./language-choice";
import { CopyAction, Seg, useToast } from "./kit";

type Admission = CallPageDTO["call"]["admission"];
type Call = CallPageDTO["call"];
const ADMISSION: readonly (readonly [Admission, string])[] = [
  ["anyone", "Anyone with the link"],
  ["knock", "Ask to join"],
];

/** The call link, who can join, and the transcript language. Each setting applies on the spot and rolls back if the server refuses, so a choice never waits on the network. */
export function CallSettings({ spaceId, call, inviteUrl, update }: { readonly spaceId: string; readonly call: Call; readonly inviteUrl: string; readonly update: (change: (data: CallPageDTO) => CallPageDTO) => void }) {
  const toast = useToast();
  const [savingLanguage, setSavingLanguage] = useState(false);

  /** Shows `patch` now, then the server's answer; on refusal it shows `revert`, tells the user and returns false. */
  async function change(patch: Partial<Call>, revert: Partial<Call>, save: () => Promise<{ call: Call }>): Promise<boolean> {
    update((data) => ({ ...data, call: { ...data.call, ...patch } }));
    try {
      const { call: changed } = await save();
      update((data) => ({ ...data, call: changed }));
      return true;
    } catch (error) {
      update((data) => ({ ...data, call: { ...data.call, ...revert } }));
      toast(errorMessage(error), { icon: "alert" });
      return false;
    }
  }

  async function setAdmission(admission: Admission) {
    if (admission === call.admission) return;
    await change({ admission }, { admission: call.admission }, () => act("call", { action: "set-admission", spaceId, admission }));
  }

  async function setLanguage(transcriptLanguage: NewCallLanguage) {
    const before = call.transcriptLanguage ?? null;
    if (transcriptLanguage === before) return;
    setSavingLanguage(true);
    const saved = await change({ transcriptLanguage }, { transcriptLanguage: before }, () => act("call", { action: "set-transcript-language", spaceId, transcriptLanguage }));
    if (saved && transcriptLanguage && transcriptLanguage !== "auto") rememberLanguage(transcriptLanguage);
    setSavingLanguage(false);
  }

  return (
    <div className="cset">
      <div>
        <h2>Call link</h2>
        <div className="linkrow">
          <div className="linkbox">
            <span>{displayLink(inviteUrl)}</span>
          </div>
          <CopyAction text={inviteUrl} pill />
        </div>
        <p className="help">This link never changes. Share it once and use it every time.</p>
      </div>
      <div id="access">
        <h2 id="who-can-join">Who can join</h2>
        <Seg labelledBy="who-can-join" options={ADMISSION} value={call.admission} onChange={(value) => void setAdmission(value)} />
        <p className="help swap" key={call.admission}>
          {call.admission === "anyone" ? "People with the link join right away." : "People ask to join, and someone in the call lets them in."}
        </p>
      </div>
      <div id="transcript-language">
        <h2 id="transcript-language-label">Transcript language</h2>
        <LanguagePicker id="transcript-language-picker" labelledBy="transcript-language-label" describedBy="transcript-language-help" allowDefault value={call.transcriptLanguage ?? null} loading={savingLanguage} loadingLabel="Saving…" onChange={(value) => void setLanguage(value)} />
        <p className="help" id="transcript-language-help">
          Applies to new transcripts for this call.
        </p>
      </div>
    </div>
  );
}
