import { Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode, type RefObject } from "react";

import type { RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { VIDEO, videoState } from "../../lib/dashboard/recording";
import { selection, transcriptView, type Attempt, type TranscriptView } from "../../lib/dashboard/tracking";
import { clock } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { ContactSupport } from "./ContactSupport";
import { Player } from "./SessionPlayer";
import type { Actions, Ids, Page } from "./session-reads";
import { TranscriptPanel } from "./TranscriptPanel";
import { useIntentKeys, useToast } from "./kit";
import { Menu, MenuItem } from "./menu";

export type Parts = {
  readonly recording: RecordingDTO | undefined;
  readonly playable: boolean;
  readonly downloadableTranscript: TranscriptDTO | null;
  readonly transcript: TranscriptView["kind"];
  /** The transcript follows the video on screen, so a click on a line plays from it. */
  readonly seekable: boolean;
  readonly media: ReactNode;
  readonly panel: ReactNode;
};

/** Only a different video resets playback, so the viewer is keyed by it; transcript selection resets its own panel. */
export function SessionViewer({ ids, page, actions, children }: { readonly ids: Ids; readonly page: Page; readonly actions: Actions; readonly children: (parts: Parts) => ReactNode }) {
  const { video, newer, transcript } = selection(page.attempts);
  return <Viewer key={video?.recording.id ?? "none"} ids={ids} item={video} transcribed={transcript} newer={newer?.recording} actions={actions} render={children} />;
}

function Viewer({ ids, item, transcribed, newer, actions, render }: { readonly ids: Ids; readonly item: Attempt | undefined; readonly transcribed: Attempt | undefined; readonly newer: RecordingDTO | undefined; readonly actions: Actions; readonly render: (parts: Parts) => ReactNode }) {
  const { onRecording, onTranscript, onRefused } = actions;
  const recording = item?.recording;
  const transcript: TranscriptView = transcribed ? transcriptView(transcribed) : { kind: "none" };
  const intents = useIntentKeys();
  const toast = useToast();
  const [time, setTime] = useState(0);
  const seek = useRef<(seconds: number) => void>(() => {});
  const [exporting, setExporting] = useState(false);

  const unreadable = item?.read.failure?.kind === "terminal" ? item.read.failure.message : null;
  const playable = recording !== undefined && !unreadable && videoState(recording) === "play";
  const downloadableTranscript = transcript.kind === "ready" ? transcript.transcript : null;
  if (!recording) return render({ recording, playable, downloadableTranscript, transcript: transcript.kind, seekable: false, media: null, panel: null });

  async function prepareRecording(target: RecordingDTO) {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await act("past-session", { action: "export-recording", ...ids, recordingId: target.id, idempotencyKey: intents.key(`export:${target.id}`) });
      onRecording(result.recording);
      intents.done(`export:${target.id}`);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      onRefused(target.id);
    } finally {
      setExporting(false);
    }
  }
  const media = <RecordingMedia ids={ids} recording={recording} unreadable={unreadable} newer={newer} exporting={exporting} onTime={setTime} seekRef={seek} onPrepare={(target) => void prepareRecording(target)} />;
  async function createTranscript(target: RecordingDTO) {
    const recordingId = target.id;
    try {
      const created = await act("past-session", { action: "create-transcript", ...ids, recordingId, idempotencyKey: intents.key(`transcript:${recordingId}`) });
      intents.done(`transcript:${recordingId}`);
      onTranscript(recordingId, created.transcript);
      toast("Making the transcript. It shows here when it’s ready.", { icon: "clock" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      onRefused(recordingId);
    }
  }
  const target = transcribed?.recording ?? recording;
  // A transcript from another attempt doesn't follow this video, so it names its attempt and its lines don't seek.
  const panel =
    target.id === recording.id ? (
      <TranscriptPanel key={target.id} transcript={transcript} time={time} onSeek={(seconds) => seek.current(seconds)} onCreate={() => createTranscript(target)} />
    ) : (
      <TranscriptPanel key={target.id} transcript={transcript} time={-1} from={clock(target.createdAt)} onCreate={() => createTranscript(target)} />
    );
  return render({ recording, playable, downloadableTranscript, transcript: transcript.kind, seekable: playable && target.id === recording.id, media, panel });
}

type MediaProps = {
  readonly ids: Ids;
  readonly recording: RecordingDTO;
  readonly unreadable: string | null;
  readonly newer: RecordingDTO | undefined;
  readonly exporting: boolean;
  readonly onTime: (seconds: number) => void;
  readonly seekRef: RefObject<(seconds: number) => void>;
  readonly onPrepare: (target: RecordingDTO) => void;
};

function PrepareButton({ action, exporting, onClick }: { readonly action: "prepare" | "retry"; readonly exporting: boolean; readonly onClick: () => void }) {
  return (
    <button type="button" className="btn pri lg" aria-busy={exporting || undefined} disabled={exporting} onClick={onClick}>
      {exporting ? <span className="spin" aria-hidden="true" /> : <Icon name={action === "retry" ? "retry" : "film"} />}
      {exporting ? "Preparing…" : action === "retry" ? "Try again" : "Prepare recording"}
    </button>
  );
}

const NEWER_NOTE = {
  retry: { title: "A newer recording couldn’t be prepared", detail: "Try again to watch or download it here." },
  prepare: { title: "A newer recording is ready to prepare", detail: "Prepare it to watch or download it here." },
  waiting: { title: "Preparing the newer recording", detail: "It replaces this video here when it’s ready." },
} as const;

/** A newer recording than the one playing, and what the viewer can do to get it. */
function NewerNote({ newer, exporting, onPrepare }: { readonly newer: RecordingDTO; readonly exporting: boolean; readonly onPrepare: (target: RecordingDTO) => void }) {
  const action = VIDEO[videoState(newer)].action;
  const note = NEWER_NOTE[action === null ? "waiting" : action === "retry" ? "retry" : "prepare"];
  return (
    <div className="pnote" role="status">
      <div>
        {action ? <Icon name="film" /> : <span className="spin" aria-hidden="true" />}
        <b>{note.title}</b>
        <p>{note.detail}</p>
        {action === "prepare" || action === "retry" ? <PrepareButton action={action} exporting={exporting} onClick={() => onPrepare(newer)} /> : null}
      </div>
    </div>
  );
}

const ALERTING = new Set(["capture_failed", "retryable", "export_failed"]);

/** The video, or the reason there is none, with what the viewer can do about it. */
function RecordingMedia({ ids, recording, unreadable, newer, exporting, onTime, seekRef, onPrepare }: MediaProps) {
  const video = videoState(recording);
  const note = VIDEO[video];
  if (unreadable)
    return (
      <div className="pnote" role="alert">
        <div>
          <Icon name="alert" />
          <b>Couldn’t load this recording</b>
          <p>{unreadable}</p>
        </div>
      </div>
    );
  if (video === "play")
    return (
      <>
        <Player ids={ids} recording={recording} onTime={onTime} seekRef={seekRef} />
        {newer ? <NewerNote newer={newer} exporting={exporting} onPrepare={onPrepare} /> : null}
      </>
    );
  return (
    <div className="pnote" role={ALERTING.has(video) ? "alert" : "status"}>
      <div>
        {video === "capturing" || video === "preparing" ? <span className="spin" aria-hidden="true" /> : <Icon name={note.action === "prepare" ? "film" : "recOff"} />}
        <b>{note.title}</b>
        <p>{recording.failureMessage || note.detail}</p>
        {note.action === "prepare" || note.action === "retry" ? <PrepareButton action={note.action} exporting={exporting} onClick={() => onPrepare(recording)} /> : video === "capture_failed" || video === "export_failed" ? <ContactSupport problem={note.title} size="lg" /> : null}
        {video === "preparable" ? (
          <p className="pnote-more">
            <Link to="/dashboard/developer" hash="recording-videos">
              Prepare every recording on its own
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function DownloadMenu({ ids, recording, video, transcript }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly video: boolean; readonly transcript: TranscriptDTO | null }) {
  const toast = useToast();
  async function downloadRecording() {
    try {
      window.location.assign((await act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: true })).url);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  function downloadTranscript(transcriptId: string) {
    const query = new URLSearchParams({ ...ids, transcriptId });
    window.location.assign(`/dashboard-api/transcript-text?${query}`);
  }

  return (
    <Menu
      label="Download"
      trigger={({ open, toggle }) => (
        <button type="button" className="btn sec" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Icon name="dl" />
          Download
          <Icon name="down" />
        </button>
      )}
    >
      {(close) => (
        <>
          {video ? (
            <MenuItem
              icon="film"
              onSelect={() => {
                close();
                void downloadRecording();
              }}
            >
              Recording (MP4)
            </MenuItem>
          ) : null}
          {transcript ? (
            <MenuItem
              icon="file"
              onSelect={() => {
                close();
                downloadTranscript(transcript.id);
              }}
            >
              Transcript (text)
            </MenuItem>
          ) : null}
        </>
      )}
    </Menu>
  );
}
