import type { IncomingMediaRequest, Participant, SpaceSnapshot } from "./types";

/** Something that happened in a live call, which a UI may announce. `SpaceClient` emits these as `callEvent`. */
export type CallEvent =
  | { readonly kind: "joined"; readonly participant: Participant }
  | { readonly kind: "left"; readonly participant: Participant }
  | { readonly kind: "handRaised"; readonly participant: Participant }
  | { readonly kind: "shareStopped"; readonly participant: Participant }
  /** `previousHost` is the host who left, when the new host took over from one. */
  | { readonly kind: "hostChanged"; readonly previousHost: Participant | null }
  /** The microphone went off without the person asking. `by` is the one participant who could have muted it, if there is exactly one. */
  | { readonly kind: "mutedByHost"; readonly by: Participant | null }
  | { readonly kind: "mediaRequest"; readonly request: IncomingMediaRequest }
  | { readonly kind: "recordingStarted" }
  | { readonly kind: "recordingStopped" }
  | { readonly kind: "recordingFailed"; readonly failureCode: string | null }
  /** The selected device vanished and the client switched to another one. Labels may be empty. */
  | { readonly kind: "deviceSwitched"; readonly source: "microphone" | "camera"; readonly from: string; readonly to: string };

/**
 * The call events between two snapshots. Only changes inside a live call count, so the roster
 * arriving on join or emptying on leave says nothing, and nothing the local participant did to
 * themselves is reported except through `ownMicrophoneOff`. `ownMicrophoneOff` is true when the
 * person turned their own microphone off, so it is not reported as a host mute.
 */
export function callEvents(previous: SpaceSnapshot, next: SpaceSnapshot, ownMicrophoneOff = false): readonly CallEvent[] {
  if (previous.connection.status !== "live" || next.connection.status !== "live") return [];
  return [...rosterEvents(previous, next), ...mutedByHostEvents(previous, next, ownMicrophoneOff), ...mediaRequestEvents(previous, next), ...recordingEvents(previous, next), ...deviceEvents(previous, next)];
}

function rosterEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const self = next.self.participantId;
  const before = new Map(previous.participants.roster.map((participant) => [participant.participantId, participant]));
  const after = next.participants.roster;
  const departed = previous.participants.roster.filter((participant) => participant.participantId !== self && !after.some((current) => current.participantId === participant.participantId));
  const becameHost = !previous.self.can("endEpisode") && next.self.can("endEpisode");
  const departedHost = becameHost ? departed.find((participant) => participant.capabilities.includes("endEpisode")) : undefined;
  const hostChanged: CallEvent[] = becameHost ? [{ kind: "hostChanged", previousHost: departedHost ?? null }] : [];
  const others = after.flatMap((participant): CallEvent[] => {
    if (participant.participantId === self) return [];
    const old = before.get(participant.participantId);
    return old ? changedParticipantEvents(old, participant) : [{ kind: "joined", participant }];
  });
  const left = departed.filter((participant) => participant !== departedHost).map((participant): CallEvent => ({ kind: "left", participant }));
  return [...hostChanged, ...others, ...left];
}

function changedParticipantEvents(old: Participant, participant: Participant): CallEvent[] {
  const events: CallEvent[] = [];
  if (!old.handRaised && participant.handRaised) events.push({ kind: "handRaised", participant });
  if (old.media.screenShare === "active" && participant.media.screenShare === "inactive") events.push({ kind: "shareStopped", participant });
  return events;
}

function mutedByHostEvents(previous: SpaceSnapshot, next: SpaceSnapshot, ownMicrophoneOff: boolean): CallEvent[] {
  const wentOff = previous.media.local.microphone.state === "enabled" && next.media.local.microphone.state === "disabled";
  return wentOff && !ownMicrophoneOff ? [{ kind: "mutedByHost", by: soleMuter(next) }] : [];
}

/** The one participant who could have muted the microphone, or null when there are none or several. */
function soleMuter(next: SpaceSnapshot): Participant | null {
  const muters = next.participants.roster.filter((participant) => participant.participantId !== next.self.participantId && participant.capabilities.includes("muteOthers"));
  return muters.length === 1 ? (muters[0] ?? null) : null;
}

function mediaRequestEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const knownRequests = new Set(previous.media.incomingRequests.map((request) => request.requestId));
  return next.media.incomingRequests.filter((request) => !knownRequests.has(request.requestId)).map((request): CallEvent => ({ kind: "mediaRequest", request }));
}

type CurrentRecording = SpaceSnapshot["recording"]["current"];

function recordingEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const was = previous.recording.current;
  const now = next.recording.current;
  return [...recordingStarted(was, now), ...recordingStopped(was, now), ...recordingFailed(was, now)];
}

function recordingStarted(was: CurrentRecording, now: CurrentRecording): CallEvent[] {
  return was?.status !== "recording" && now?.status === "recording" ? [{ kind: "recordingStarted" }] : [];
}

function recordingStopped(was: CurrentRecording, now: CurrentRecording): CallEvent[] {
  return was?.status === "recording" && now?.status !== "recording" && now?.status !== "failed" ? [{ kind: "recordingStopped" }] : [];
}

function recordingFailed(was: CurrentRecording, now: CurrentRecording): CallEvent[] {
  if (now?.status !== "failed") return [];
  const alreadyReported = was?.status === "failed" && was.recordingId === now.recordingId;
  return alreadyReported ? [] : [{ kind: "recordingFailed", failureCode: now.failureCode }];
}

function deviceEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const events: CallEvent[] = [];
  for (const source of ["microphone", "camera"] as const) {
    const wasSelected = previous.media.selection[source];
    if (wasSelected === next.media.selection[source]) continue;
    const devices = source === "camera" ? next.media.devices.cameras : next.media.devices.microphones;
    const oldDevices = source === "camera" ? previous.media.devices.cameras : previous.media.devices.microphones;
    const disconnected = oldDevices.find((device) => device.deviceId === wasSelected);
    if (!disconnected || devices.some((device) => device.deviceId === disconnected.deviceId)) continue;
    const selected = devices.find((device) => device.deviceId === next.media.selection[source]);
    if (selected) events.push({ kind: "deviceSwitched", source, from: disconnected.label, to: selected.label });
  }
  return events;
}
