import type { JoinOptions } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NO_DETECTED_DEVICES, watchMediaDevices, type DetectedMediaDevices } from "../internal/media-devices";
import { playSpeakerTestTone } from "../internal/speaker-test";
import { useInputLevel } from "../internal/useInputLevel";
import { useMirrorSetting } from "../internal/useStoredSettings";
import { readRememberedDevices, rememberDevices, type RememberedDevices } from "./remembered-devices";

/**
 * `checking` reads the browser's permission, `ask` waits for the visitor to turn devices on, `requesting` waits for the browser prompt,
 * `blocked` means the browser refuses, and `granted` means the preview can run.
 */
export type PreJoinAccess = "checking" | "ask" | "requesting" | "blocked" | "granted";

/** The device choice to hand to `client.join()`. Devices that are not live join off. */
export type PreJoinJoinOptions = Required<Pick<JoinOptions, "microphone" | "camera">> & Pick<JoinOptions, "microphoneDeviceId" | "cameraDeviceId" | "speakerDeviceId">;

export type PreJoinDevices = {
  readonly access: PreJoinAccess;
  /** Asks the browser for camera and microphone together and turns both on. Also the retry after `blocked`. */
  readonly requestAccess: () => void;
  readonly microphones: readonly MediaDeviceInfo[];
  readonly cameras: readonly MediaDeviceInfo[];
  readonly speakers: readonly MediaDeviceInfo[];
  readonly microphoneId: string | undefined;
  readonly cameraId: string | undefined;
  readonly speakerId: string | undefined;
  /** Live and wanted: what the visitor would join with. */
  readonly microphoneOn: boolean;
  readonly cameraOn: boolean;
  /** Access is granted but the browser has no device, or could not open it. */
  readonly microphoneMissing: boolean;
  readonly cameraMissing: boolean;
  readonly setMicrophoneOn: (on: boolean) => void;
  readonly setCameraOn: (on: boolean) => void;
  readonly selectMicrophone: (deviceId: string) => void;
  readonly selectCamera: (deviceId: string) => void;
  readonly selectSpeaker: (deviceId: string) => void;
  readonly cameraTrack: MediaStreamTrack | null;
  /** The microphone's loudness from 0 to 100. */
  readonly microphoneLevel: number;
  readonly mirrored: boolean;
  /** Safari and iOS cannot pick an output, so the speaker row stays hidden there. */
  readonly canChooseSpeaker: boolean;
  readonly speakerTesting: boolean;
  /** Plays the test tone through the chosen speaker. Never rejects: a tone the browser refuses leaves nothing for the visitor to fix. */
  readonly testSpeaker: () => Promise<void>;
  readonly joinOptions: PreJoinJoinOptions;
  /** Remembers the choice, so the next visit can skip this step, and returns what to join with. */
  readonly commit: () => PreJoinJoinOptions;
};

type Source = "microphone" | "camera";
type Failure = "denied" | "missing" | "failed";
type Capture = {
  readonly microphone: MediaStreamTrack | null;
  readonly camera: MediaStreamTrack | null;
  readonly missing: ReadonlySet<Source>;
  readonly denied: boolean;
};
const NOTHING_CAPTURED: Capture = { microphone: null, camera: null, missing: new Set(), denied: false };

/**
 * Owns the one preview stream shown before joining: it opens the camera and microphone the visitor wants, follows device changes,
 * remembers the choice per browser, and stops every track when the component unmounts, so the camera light goes off.
 */
export function usePreJoinDevices(): PreJoinDevices {
  const [choice, setChoice] = useState<RememberedDevices>(() => readRememberedDevices() ?? { microphone: true, camera: true });
  const [access, setAccess] = useState<PreJoinAccess>("checking");
  const [devices, setDevices] = useState<DetectedMediaDevices | null>(null);
  const [capture, setCapture] = useState<Capture>(NOTHING_CAPTURED);
  const [generation, setGeneration] = useState(0);
  const [speakerTesting, setSpeakerTesting] = useState(false);
  const [mirrored] = useMirrorSetting();
  const refreshDevices = useRef<() => void>(() => undefined);
  const stream = useRef<MediaStream | null>(null);

  const latestChoice = useRef(choice);
  const update = (change: Partial<RememberedDevices>) => {
    const next = { ...latestChoice.current, ...change };
    latestChoice.current = next;
    setChoice(next);
  };

  const microphones = devices?.audioinput ?? NO_DETECTED_DEVICES.audioinput;
  const cameras = devices?.videoinput ?? NO_DETECTED_DEVICES.videoinput;
  const speakers = devices?.audiooutput ?? NO_DETECTED_DEVICES.audiooutput;
  const chosenMicrophone = knownDevice(choice.microphoneDeviceId, microphones);
  const chosenCamera = knownDevice(choice.cameraDeviceId, cameras);
  const chosenSpeaker = knownDevice(choice.speakerDeviceId, speakers);
  const capturing = access === "granted" || access === "requesting";
  const devicesKnown = devices !== null;

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Enumerate devices and follow devicechange; remove the listener and ignore late results on cleanup.
  useEffect(() => {
    if (!navigator.mediaDevices) {
      setDevices(NO_DETECTED_DEVICES);
      return;
    }
    const watch = watchMediaDevices(setDevices);
    refreshDevices.current = watch.refresh;
    return watch.stop;
  }, []);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Read the camera and microphone permission and follow its changes; remove the listeners and ignore late answers on cleanup.
  useEffect(() => {
    let cancelled = false;
    const statuses: PermissionStatus[] = [];
    const settle = () => {
      if (cancelled) return;
      const states = statuses.map((status) => status.state);
      const next = states.includes("denied") ? "blocked" : states.every((state) => state === "granted") ? "granted" : "ask";
      setAccess((current) => (current === "requesting" ? current : next));
    };
    void (async () => {
      try {
        for (const name of ["camera", "microphone"] as const) statuses.push(await navigator.permissions.query({ name }));
      } catch {
        // Firefox cannot query camera permission. Device labels appear only once access exists, so they stand in for the answer.
        const known = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
        if (!cancelled) setAccess(known.some((device) => device.label !== "") ? "granted" : "ask");
        return;
      }
      for (const status of statuses) status.addEventListener("change", settle);
      settle();
    })();
    return () => {
      cancelled = true;
      for (const status of statuses) status.removeEventListener("change", settle);
    };
  }, []);

  const wantMicrophone = capturing && choice.microphone;
  const wantCamera = capturing && choice.camera;
  const hasMicrophone = microphones.length > 0;
  const hasCamera = cameras.length > 0;
  // A device that failed to open gets another try when the browser lists a different set of devices.
  const retryMicrophone = capture.missing.has("microphone") ? microphones.map((device) => device.deviceId).join() : "";
  const retryCamera = capture.missing.has("camera") ? cameras.map((device) => device.deviceId).join() : "";
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Open one preview stream for the wanted devices; replace it only when the new one is ready and stop late captures on cleanup.
  useEffect(() => {
    if (!devicesKnown) return;
    if (!wantMicrophone && !wantCamera) {
      adopt(stream, null);
      setCapture(NOTHING_CAPTURED);
      return;
    }
    // A device the visitor turned off stops now; the others keep running until their replacement is ready.
    if (!wantMicrophone) stream.current?.getAudioTracks().forEach((track) => track.stop());
    if (!wantCamera) stream.current?.getVideoTracks().forEach((track) => track.stop());
    let cancelled = false;
    let settled = false;
    const held: MediaStream[] = [];
    void openPreview(wantMicrophone ? { deviceId: chosenMicrophone } : false, wantCamera ? { deviceId: chosenCamera } : false, held).then((opened) => {
      if (cancelled) {
        opened.stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      adopt(stream, opened.stream);
      const tracks = { microphone: opened.stream?.getAudioTracks()[0] ?? null, camera: opened.stream?.getVideoTracks()[0] ?? null };
      for (const track of [tracks.microphone, tracks.camera]) track?.addEventListener("ended", () => setGeneration((count) => count + 1), { once: true });
      setCapture({ ...tracks, missing: opened.missing, denied: opened.denied });
      setAccess(opened.denied ? "blocked" : "granted");
      refreshDevices.current();
    });
    return () => {
      cancelled = true;
      // A fallback capture that is still waiting on the next one must not outlive the step.
      if (!settled) held.forEach((captured) => captured.getTracks().forEach((track) => track.stop()));
    };
  }, [devicesKnown, wantMicrophone, wantCamera, chosenMicrophone, chosenCamera, hasMicrophone, hasCamera, retryMicrophone, retryCamera, generation]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Stop the preview tracks when the step unmounts so the camera light goes off.
  useEffect(() => () => adopt(stream, null), []);

  const granted = access === "granted";
  const microphoneMissing = granted && (capture.missing.has("microphone") || (devicesKnown && !hasMicrophone));
  const cameraMissing = granted && (capture.missing.has("camera") || (devicesKnown && !hasCamera));
  const microphoneOn = granted && choice.microphone && !microphoneMissing;
  const cameraOn = granted && choice.camera && !cameraMissing;
  const microphoneId = chosenMicrophone ?? knownDevice(capture.microphone?.getSettings().deviceId, microphones) ?? microphones[0]?.deviceId;
  const cameraId = chosenCamera ?? knownDevice(capture.camera?.getSettings().deviceId, cameras) ?? cameras[0]?.deviceId;
  const canChooseSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const speakerId = chosenSpeaker ?? speakers[0]?.deviceId;
  const microphoneLevel = useInputLevel(microphoneOn ? capture.microphone : null);

  const testSpeaker = useCallback(async () => {
    setSpeakerTesting(true);
    try {
      await playSpeakerTestTone(chosenSpeaker);
    } catch {
      /* A refused tone, for example by autoplay rules, leaves the speaker row as it was. */
    } finally {
      setSpeakerTesting(false);
    }
  }, [chosenSpeaker]);

  const joinOptions = useMemo<PreJoinJoinOptions>(
    () => ({
      microphone: microphoneOn,
      camera: cameraOn,
      ...(granted && microphoneId ? { microphoneDeviceId: microphoneId } : {}),
      ...(granted && cameraId ? { cameraDeviceId: cameraId } : {}),
      ...(granted && canChooseSpeaker && chosenSpeaker ? { speakerDeviceId: chosenSpeaker } : {}),
    }),
    [granted, microphoneOn, cameraOn, microphoneId, cameraId, canChooseSpeaker, chosenSpeaker],
  );

  return {
    access,
    requestAccess: () => {
      setAccess("requesting");
      update({ microphone: true, camera: true });
    },
    microphones,
    cameras,
    speakers,
    microphoneId,
    cameraId,
    speakerId,
    microphoneOn,
    cameraOn,
    microphoneMissing,
    cameraMissing,
    setMicrophoneOn: (on) => update({ microphone: on }),
    setCameraOn: (on) => update({ camera: on }),
    selectMicrophone: (deviceId) => update({ microphoneDeviceId: deviceId }),
    selectCamera: (deviceId) => update({ cameraDeviceId: deviceId }),
    selectSpeaker: (deviceId) => update({ speakerDeviceId: deviceId }),
    cameraTrack: cameraOn ? capture.camera : null,
    microphoneLevel,
    mirrored,
    canChooseSpeaker,
    speakerTesting,
    testSpeaker,
    joinOptions,
    commit: () => {
      // The toggles are what the visitor asked for, so a camera that was busy once does not turn it off for good. Only picked device ids are kept.
      if (granted) rememberDevices(latestChoice.current);
      return joinOptions;
    },
  };
}

/** A remembered device only counts while the browser still lists it. */
function knownDevice(deviceId: string | undefined, listed: readonly MediaDeviceInfo[]): string | undefined {
  return deviceId !== undefined && listed.some((device) => device.deviceId === deviceId) ? deviceId : undefined;
}

/** Keeps the previous stream running until its replacement is ready, so a camera switch never flashes black. */
function adopt(current: { current: MediaStream | null }, next: MediaStream | null): void {
  current.current?.getTracks().forEach((track) => track.stop());
  current.current = next;
}

type Request = false | { readonly deviceId: string | undefined };

/** `held` collects every stream as soon as the browser hands it over, so the caller can stop it before the whole sequence ends. */
async function openPreview(microphone: Request, camera: Request, held: MediaStream[]): Promise<{ readonly stream: MediaStream | null; readonly missing: ReadonlySet<Source>; readonly denied: boolean }> {
  const together = await attempt(microphone, camera, held);
  if (together.stream) return { stream: together.stream, missing: new Set(), denied: false };
  // One absent, busy or refused device fails a combined request, so each wanted device gets its own try.
  const separate = microphone && camera ? [await attempt(microphone, false, held), await attempt(false, camera, held)] : [together];
  const sources: readonly Source[] = microphone && camera ? ["microphone", "camera"] : [microphone ? "microphone" : "camera"];
  const tracks = separate.flatMap((result) => result.stream?.getTracks() ?? []);
  const missing = new Set(sources.filter((_, index) => separate[index]?.stream === undefined));
  return { stream: tracks.length > 0 ? new MediaStream(tracks) : null, missing, denied: tracks.length === 0 && separate.some((result) => result.failure === "denied") };
}

async function attempt(microphone: Request, camera: Request, held: MediaStream[]): Promise<{ readonly stream?: MediaStream; readonly failure?: Failure }> {
  if (!microphone && !camera) return { failure: "missing" };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint(microphone), video: constraint(camera) });
    held.push(stream);
    return { stream };
  } catch (cause) {
    return { failure: classify(cause) };
  }
}

function constraint(request: Request): boolean | MediaTrackConstraints {
  if (!request) return false;
  return request.deviceId === undefined ? true : { deviceId: { exact: request.deviceId } };
}

function classify(cause: unknown): Failure {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  return "failed";
}
