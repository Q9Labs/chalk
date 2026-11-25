import type { ScreenAnnotationClient, ScreenAnnotationState, ScreenShareCapture } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";
import { HelperOfferActions, type HelperScreen } from "./HelperOfferActions";
import { HelperOfferStep } from "./HelperOfferStep";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "./model";

const introDismissedKey = "chalk.annotation-helper.intro-dismissed";

function readIntroDismissed() {
  try {
    return globalThis.localStorage.getItem(introDismissedKey) === "1";
  } catch {
    return false;
  }
}

export function AnnotationHelperOffer({ client, state, actorId, helper, capture }: { readonly client: ScreenAnnotationClient; readonly state: ScreenAnnotationState; readonly actorId: string; readonly helper: ScreenAnnotationHelper; readonly capture?: ScreenShareCapture }) {
  const [drawing, setDrawing] = useState<string | null>(null);
  const [introDismissed, setIntroDismissed] = useState(readIntroDismissed);
  const [drawingDismissed, setDrawingDismissed] = useState(false);
  const [opened, setOpened] = useState(false);
  const [screen, setScreen] = useState<HelperScreen>({ kind: "idle" });
  const [code, setCode] = useState("");
  const attempt = useRef<AbortController | null>(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Observe the first remote mark without widening the call subscription; abort the attachment with this publication.
  useEffect(() => {
    const observe = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.state?.layer.layer_id !== state.layer.layer_id) {
        attempt.current?.abort();
        return;
      }
      const active = snapshot.state.marks.find((mark) => mark.author.participant_id !== actorId);
      const preview = snapshot.presence.find((peer) => peer.author.participant_id !== actorId && (peer.draft || peer.cursor?.tool === "pointer"));
      const name = active?.author.display_name ?? preview?.author.display_name;
      if (!snapshot.state.paused && name) setDrawing((prior) => prior ?? name);
    };
    const unsubscribe = client.subscribe(observe);
    observe();
    return () => {
      unsubscribe();
      attempt.current?.abort();
    };
  }, [client, state.layer.layer_id, actorId]);

  if (actorId !== state.layer.sharer_id) return null;
  const offersIntro = Boolean(helper.installUrl) && capture?.surface !== "browser";
  if (!opened && screen.kind === "idle" && (!drawing || drawingDismissed) && (!offersIntro || introDismissed)) {
    return offersIntro ? (
      <div className="chalk-ann-bar">
        <button type="button" className="chalk-ann-btn" onClick={() => setOpened(true)}>
          Chalk Helper
        </button>
      </div>
    ) : null;
  }
  const share: ScreenAnnotationHelperShare = { client, layer: state.layer, participantId: actorId, surface: capture?.surface ?? null };
  const start = () => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    return controller;
  };
  const attach = async (controller: AbortController, work: (status: (status: ScreenAnnotationHelperStatus) => void) => Promise<void>, fingerprint?: string) => {
    if (controller.signal.aborted) return;
    setScreen({ kind: "attaching", fingerprint });
    try {
      await work((status) => {
        if (!controller.signal.aborted) setScreen({ kind: "status", status });
      });
    } catch {
      if (!controller.signal.aborted) setScreen({ kind: "code", error: "Couldn’t connect to Chalk Helper." });
    }
  };
  const connect = async () => {
    const controller = start();
    if (!helper.challenge) return setScreen({ kind: "code" });
    setScreen({ kind: "looking" });
    try {
      const response = await helper.challenge(share, controller.signal);
      if (controller.signal.aborted) return;
      if (response.kind === "update_required") setScreen({ kind: "status", status: "update_required" });
      else if (response.remembered) {
        await attach(
          controller,
          (status) =>
            response.attach(status, async () => {
              throw new Error("A remembered Helper must not ask for a code.");
            }),
          response.fingerprint,
        );
      } else {
        setScreen({
          kind: "fingerprint",
          value: response.fingerprint,
          approve: () =>
            attach(
              controller,
              (status) =>
                response.attach(
                  status,
                  (signal) =>
                    new Promise<string>((resolve, reject) => {
                      if (signal.aborted) {
                        reject(signal.reason);
                        return;
                      }
                      const abort = () => reject(signal.reason);
                      signal.addEventListener("abort", abort, { once: true });
                      setCode("");
                      setScreen({
                        kind: "confirm",
                        fingerprint: response.fingerprint,
                        submit: (entered) => {
                          signal.removeEventListener("abort", abort);
                          setScreen({ kind: "attaching" });
                          resolve(entered);
                        },
                      });
                    }),
                ),
              response.fingerprint,
            ),
        });
      }
    } catch {
      if (!controller.signal.aborted) setScreen({ kind: "code", error: "Couldn’t reach Chalk Helper on this device." });
    }
  };
  const lookup = async () => {
    if (!helper.lookupCode) return;
    const controller = start();
    const entered = code.trim().toUpperCase();
    setCode("");
    setScreen({ kind: "looking" });
    try {
      const result = await helper.lookupCode(entered, share, controller.signal);
      if (!controller.signal.aborted) setScreen({ kind: "device", name: result.deviceName, fingerprint: result.fingerprint, approve: () => attach(controller, result.approve) });
    } catch {
      if (!controller.signal.aborted) setScreen({ kind: "code", error: "Couldn’t verify this code. Check it in Chalk Helper and try again." });
    }
  };
  const dismiss = () => {
    attempt.current?.abort();
    setCode("");
    setScreen({ kind: "idle" });
    setOpened(false);
    if (drawing) setDrawingDismissed(true);
    if (offersIntro && !introDismissed) {
      setIntroDismissed(true);
      try {
        globalThis.localStorage.setItem(introDismissedKey, "1");
      } catch {
        // The card can still be dismissed in this share when storage is blocked.
      }
    }
  };

  return (
    <div data-part="annotation-helper-offer" className="chalk-ann-card">
      <HelperOfferStep screen={screen} drawing={drawing} guidance={helper.captureGuidance?.(share)} helper={helper} code={code} setCode={setCode} connect={connect} lookup={lookup} />
      <HelperOfferActions
        screen={screen}
        helper={helper}
        dismiss={dismiss}
        useCode={() => {
          start();
          setScreen({ kind: "code" });
        }}
      />
    </div>
  );
}
