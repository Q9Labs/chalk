import { useId, useState, type MouseEvent } from "react";

import { playbackTime } from "../../lib/dashboard/format";
import { bucketBar, laneExtent, playheadFraction, recordingSeconds, sessionMsAt, sharePercent, talkLength, type MeasuredTalk, type TalkSpeakerDTO, type TalkTimeDTO } from "../../lib/dashboard/talk-time";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import type { Playback } from "./SessionViewer";

const EMPTY: Record<Exclude<TalkTimeDTO["kind"], "available">, { readonly title: string; readonly body: string }> = {
  "no-transcript": { title: "No talk time", body: "Talk time is measured from a transcript, and this session has none." },
  pending: { title: "Waiting for the transcript", body: "Talk time shows here once the transcript is ready. Reload this page to check." },
  live: { title: "Session still going", body: "Talk time is measured once the session ends." },
  unavailable: { title: "Talk time isn’t available", body: "It couldn’t be loaded. Reload this page to try again." },
};

/** Who talked and when, as the API measured it. Seeking needs the recording's player, so without one the timeline only reads. */
export function TalkTime({ talk, playback }: { readonly talk: TalkTimeDTO; readonly playback: Playback | null }) {
  return (
    <section className="card talk" aria-labelledby="talk-title">
      <div className="ph">
        <Icon name="mic" size={18} />
        <div>
          <h2 id="talk-title">Talk time</h2>
          <div className="sub">Measured from the transcript. Talking at the same time counts for each person.</div>
        </div>
      </div>
      {talk.kind === "available" ? <Measured talk={talk} playback={playback} /> : <Unmeasured kind={talk.kind} />}
    </section>
  );
}

function Unmeasured({ kind }: { readonly kind: Exclude<TalkTimeDTO["kind"], "available"> }) {
  const text = EMPTY[kind];
  return (
    <div className="blank">
      <span className="tile">
        <Icon name="mic" size={20} />
      </span>
      <b>{text.title}</b>
      <p>{text.body}</p>
    </div>
  );
}

function Measured({ talk, playback }: { readonly talk: MeasuredTalk; readonly playback: Playback | null }) {
  const speakers = talk.speakers.filter((speaker) => speaker.talkMs > 0);
  const totals = (
    <dl className="tts">
      <div>
        <dt>Talked at once</dt>
        <dd>{talkLength(talk.overlapMs)}</dd>
      </div>
      <div>
        <dt>Silent</dt>
        <dd>{talkLength(talk.silenceMs)}</dd>
      </div>
    </dl>
  );
  if (speakers.length === 0) {
    return (
      <>
        {totals}
        <p className="sub">Nobody was heard talking in this session.</p>
      </>
    );
  }
  return (
    <>
      {totals}
      <div className="ttt">
        <div className="ttr head" aria-hidden="true">
          <div>Person</div>
          <div className="num">Time</div>
          <div className="num">Share</div>
          <div className="dsk" />
        </div>
        {speakers.map((speaker) => (
          <div key={speaker.key} className="ttr">
            <div className="wjp">
              <Avatar name={speaker.name} size={26} />
              <span className="ell">{speaker.name}</span>
            </div>
            <div className="num">{talkLength(speaker.talkMs)}</div>
            <div className="num">{sharePercent(speaker.share)}</div>
            <div className="track dsk" aria-hidden="true">
              <i style={{ width: `${Math.max(speaker.share * 100, 1)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <Timeline talk={talk} speakers={speakers} playback={playback} />
    </>
  );
}

function Timeline({ talk, speakers, playback }: { readonly talk: MeasuredTalk; readonly speakers: readonly TalkSpeakerDTO[]; readonly playback: Playback | null }) {
  const seekable = playback !== null && recordingSeconds(talk, playback.recordingId, 0) !== null;
  const jump = (sessionMs: number) => {
    if (!playback) return;
    const seconds = recordingSeconds(talk, playback.recordingId, sessionMs);
    if (seconds !== null) playback.seek(seconds);
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    jump(sessionMsAt(event.clientX - box.left, box.width, talk.durationMs));
  };
  const head = playback ? playheadFraction(talk, playback.recordingId, playback.time) : null;
  const sliderId = useId();
  const [picked, setPicked] = useState(0);
  const stepMs = Math.max(talk.bucketMs, 1000);
  return (
    <div className="ttl">
      <div className="tth">
        <h3>When they talked</h3>
        {seekable ? <span className="sub">Click the timeline to play from there.</span> : null}
      </div>
      <div className="ttg">
        <div className="ttn">
          {speakers.map((speaker) => (
            <span key={speaker.key} className="ell">
              {speaker.name}
            </span>
          ))}
        </div>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the slider below is the keyboard and screen reader way to do what a click here does */}
        <div className={seekable ? "ttp seek" : "ttp"} onClick={seekable ? click : undefined}>
          {speakers.map((speaker) => (
            <Lane key={speaker.key} speaker={speaker} bucketMs={talk.bucketMs} extent={laneExtent(talk)} />
          ))}
          {head !== null ? <span className="ttm" style={{ left: `${head * 100}%` }} aria-hidden="true" /> : null}
          <div className="tta" aria-hidden="true">
            <span>0:00</span>
            <span>{playbackTime(talk.durationMs / 2000)}</span>
            <span>{playbackTime(talk.durationMs / 1000)}</span>
          </div>
        </div>
      </div>
      {seekable ? (
        <div className="ttj">
          <label htmlFor={sliderId}>Play from {playbackTime(picked / 1000)}</label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={talk.durationMs}
            step={stepMs}
            value={picked}
            onChange={(event) => {
              setPicked(Number(event.currentTarget.value));
              jump(Number(event.currentTarget.value));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One speaker's lane: a bar per bucket, as tall as the share of that bucket they spoke in. */
function Lane({ speaker, bucketMs, extent }: { readonly speaker: TalkSpeakerDTO; readonly bucketMs: number; readonly extent: number }) {
  return (
    <svg className="ttb" viewBox={`0 0 ${extent} 1`} preserveAspectRatio="none" role="img" aria-label={`${speaker.name}: talked ${talkLength(speaker.talkMs)} in ${speaker.turns} ${speaker.turns === 1 ? "turn" : "turns"}`}>
      {speaker.buckets.map((talk, index) => {
        const bar = bucketBar(index, extent);
        if (talk <= 0 || bar.width <= 0) return null;
        const height = Math.min(Math.max(talk / (bar.width * bucketMs), 0.15), 1);
        return <rect key={index} x={bar.x} y={1 - height} width={bar.width} height={height} />;
      })}
    </svg>
  );
}
