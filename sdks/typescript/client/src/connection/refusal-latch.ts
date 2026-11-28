import { repeatedRefusal } from "../media/capture-error";

export type CaptureKind = "audio" | "video";
export type PermissionQuery = { query(descriptor: { readonly name: "microphone" | "camera" }): Promise<EventTarget & { readonly state: string }> };
const PERMISSION_NAMES = { audio: "microphone", video: "camera" } as const;

function isPermissionRefusal(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
}

/**
 * A microphone or camera the browser refused stays refused until the person acts or the browser's permission changes,
 * so a loop that asks again costs no browser call and no telemetry. Only a request for that one device marks it,
 * because a refused request for both does not say which one was refused.
 */
export function createRefusalLatch(permissions: PermissionQuery | undefined) {
  const refused = new Map<CaptureKind, { readonly error: unknown; stopWatching: () => void }>();
  const allow = (kind: CaptureKind) => {
    refused.get(kind)?.stopWatching();
    refused.delete(kind);
  };
  const refuse = (kind: CaptureKind, error: unknown) => {
    allow(kind);
    let stopped = false;
    let release = () => {};
    // Firefox cannot be asked about the camera or microphone, so there only an act of the person lifts the refusal.
    void permissions?.query({ name: PERMISSION_NAMES[kind] }).then(
      (status) => {
        if (stopped) return;
        const changed = () => allow(kind);
        status.addEventListener("change", changed);
        release = () => status.removeEventListener("change", changed);
      },
      () => undefined,
    );
    refused.set(kind, {
      error,
      stopWatching: () => {
        stopped = true;
        release();
      },
    });
  };
  return {
    allowAll() {
      for (const kind of [...refused.keys()]) allow(kind);
    },
    wantedBy: (constraints: MediaStreamConstraints): CaptureKind[] => (["audio", "video"] as const).filter((kind) => constraints[kind]),
    rejectIfRefused(wanted: readonly CaptureKind[]) {
      for (const kind of wanted) {
        const earlier = refused.get(kind);
        if (earlier) throw repeatedRefusal(earlier.error);
      }
    },
    noteFailure(wanted: readonly CaptureKind[], error: unknown) {
      const [only] = wanted;
      if (wanted.length === 1 && only && isPermissionRefusal(error)) refuse(only, error);
    },
  };
}
