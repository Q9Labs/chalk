import type { ScreenAnnotationClient, ScreenAnnotationState, ScreenShareCapture } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePhoneCall } from "../../internal/call-width";
import { HelperOfferStep, type HelperScreen } from "./HelperOfferStep";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "./model";

const introDismissedKey = "chalk.annotation-helper.intro-dismissed";

function readIntroDismissed() {
  try {
    return globalThis.localStorage.getItem(introDismissedKey) === "1";
  } catch {
    return false;
  }
}

export function AnnotationHelperOffer({
  client,
  state,
  actorId,
  helper,
  capture,
  open,
  onOpenChange,
  onShowing,
}: {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly actorId: string;
  readonly helper: ScreenAnnotationHelper;
  readonly capture?: ScreenShareCapture;
  /** The sharer asked to see the marks on their own screen. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether Chalk Helper is connected and drawing the marks on the sharer's screen. */
  readonly onShowing: (showing: boolean) => void;
}) {
  const phone = usePhoneCall();
  const [introDismissed, setIntroDismissed] = useState(readIntroDismissed);
  const opened = open;
  const setOpened = onOpenChange;
  const [screen, setScreen] = useState<HelperScreen>({ kind: "idle" });
  const [code, setCode] = useState("");
  const attempt = useRef<AbortController | null>(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Abort the attachment when this publication's layer goes away.
  useEffect(() => {
    const observe = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.state?.layer.layer_id !== state.layer.layer_id) {
        attempt.current?.abort();
        return;
      }
    };
    const unsubscribe = client.subscribe(observe);
    observe();
    return () => {
      unsubscribe();
      attempt.current?.abort();
    };
  }, [client, state.layer.layer_id, actorId]);

  const showing = screen.kind === "status" && (screen.status === "ready" || screen.status === "device_approved");
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Tell the sharer's bar whether Helper is already drawing the marks.
  useEffect(() => onShowing(showing), [showing, onShowing]);

  if (actorId !== state.layer.sharer_id) return null;
  const offersIntro = Boolean(helper.installUrl) && capture?.surface !== "browser";
  if (!opened && screen.kind === "idle" && (!offersIntro || introDismissed)) return null;
  if (screen.kind === "status" && screen.status === "ready") return null;
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
    <div
      data-part="annotation-helper-offer"
      data-phone={phone ? "" : undefined}
      role="region"
      aria-label="Chalk Helper"
      className="chalk-pair"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || screen.kind === "idle") return;
        event.stopPropagation();
        dismiss();
      }}
    >
      <HelperOfferStep screen={screen} guidance={helper.captureGuidance?.(share)} helper={helper} code={code} setCode={setCode} connect={connect} lookup={lookup} />
      <button type="button" className="chalk-ann-btn chalk-pair-x" aria-label="Close" onClick={dismiss}>
        <HugeiconsIcon icon={Cancel01Icon} size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
