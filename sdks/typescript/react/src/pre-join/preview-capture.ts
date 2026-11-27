export type CaptureSource = "microphone" | "camera";
export type CaptureFailure = "denied" | "missing" | "failed";
export type Capture = {
  readonly microphone: MediaStreamTrack | null;
  readonly camera: MediaStreamTrack | null;
  readonly missing: ReadonlySet<CaptureSource>;
  readonly denied: boolean;
};
export const NOTHING_CAPTURED: Capture = { microphone: null, camera: null, missing: new Set(), denied: false };

type Request = false | { readonly deviceId: string | undefined };

/** `held` collects every stream as soon as the browser hands it over, so the caller can stop it before the whole sequence ends. */
export async function openPreview(microphone: Request, camera: Request, held: MediaStream[]): Promise<{ readonly stream: MediaStream | null; readonly missing: ReadonlySet<CaptureSource>; readonly denied: boolean }> {
  const together = await attempt(microphone, camera, held);
  if (together.stream) return { stream: together.stream, missing: new Set(), denied: false };
  // One absent, busy or refused device fails a combined request, so each wanted device gets its own try.
  const separate = microphone && camera ? [await attempt(microphone, false, held), await attempt(false, camera, held)] : [together];
  const sources: readonly CaptureSource[] = microphone && camera ? ["microphone", "camera"] : [microphone ? "microphone" : "camera"];
  const tracks = separate.flatMap((result) => result.stream?.getTracks() ?? []);
  const missing = new Set(sources.filter((_, index) => separate[index]?.stream === undefined));
  return { stream: tracks.length > 0 ? new MediaStream(tracks) : null, missing, denied: tracks.length === 0 && separate.some((result) => result.failure === "denied") };
}

async function attempt(microphone: Request, camera: Request, held: MediaStream[]): Promise<{ readonly stream?: MediaStream; readonly failure?: CaptureFailure }> {
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

function classify(cause: unknown): CaptureFailure {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  return "failed";
}
