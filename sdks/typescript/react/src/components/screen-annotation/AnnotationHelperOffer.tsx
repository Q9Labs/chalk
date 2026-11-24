import type { ScreenAnnotationClient, ScreenAnnotationState, ScreenShareCapture } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";
import { HelperOfferActions, type HelperScreen } from "./HelperOfferActions";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "./model";

const statuses: Record<ScreenAnnotationHelperStatus, string> = {
  waiting_for_sync: "Connecting Chalk Helper to the call…",
  unbound: "Chalk Helper is connected. Choose the shared screen in the Helper.",
  calibrating: "Match the preview in Chalk Helper.",
  ready: "Marks show on your screen",
  unsupported_surface: "Chalk Helper can’t show marks on this source. Use the call preview instead.",
  device_approved: "Device approved. Use the call preview for marks.",
  update_required: "Update Chalk Helper to connect.",
  disconnected: "Chalk Helper disconnected.",
};

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
      <HelperStep screen={screen} drawing={drawing} guidance={helper.captureGuidance?.(share)} helper={helper} code={code} setCode={setCode} connect={connect} lookup={lookup} />
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

function HelperStep({
  screen,
  drawing,
  guidance,
  helper,
  code,
  setCode,
  connect,
  lookup,
}: {
  readonly screen: HelperScreen;
  readonly drawing: string | null;
  readonly guidance?: string;
  readonly helper: ScreenAnnotationHelper;
  readonly code: string;
  readonly setCode: (value: string) => void;
  readonly connect: () => Promise<void>;
  readonly lookup: () => Promise<void>;
}) {
  const canConnect = !guidance && (helper.challenge || helper.lookupCode);
  return (
    <>
      {screen.kind === "idle" ? (
        <>
          <p>
            {drawing ? (
              <>
                <bdi>{drawing}</bdi> is drawing on your share.
              </>
            ) : (
              "Viewers can draw on your share."
            )}{" "}
            {guidance ?? "Use Chalk Helper to see their marks on your screen."}
          </p>
          {canConnect ? (
            <button type="button" className="chalk-ann-btn" data-tone={drawing ? "primary" : "outline"} onClick={() => void connect()}>
              {drawing ? "Connect Chalk Helper" : "Connect"}
            </button>
          ) : null}
        </>
      ) : null}
      {screen.kind === "looking" || (screen.kind === "attaching" && !screen.fingerprint) ? <p role="status">Connecting to Chalk Helper…</p> : null}
      {screen.kind === "fingerprint" ? (
        <>
          <p>Chalk Helper will ask you to match this fingerprint.</p>
          <code className="chalk-ann-code" dir="ltr">
            {screen.value}
          </code>
          <button type="button" className="chalk-ann-btn" data-tone="primary" onClick={() => void screen.approve()}>
            Open approval in Chalk Helper
          </button>
        </>
      ) : null}
      {screen.kind === "attaching" && screen.fingerprint ? (
        <>
          <p role="status">Approve in Chalk Helper only if its fingerprint matches.</p>
          <code className="chalk-ann-code" dir="ltr">
            {screen.fingerprint}
          </code>
        </>
      ) : null}
      {screen.kind === "code" ? <HelperDeviceCode error={screen.error} helper={helper} code={code} setCode={setCode} lookup={lookup} /> : null}
      {screen.kind === "confirm" ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            screen.submit(code);
            setCode("");
          }}
        >
          <p>
            Match <code dir="ltr">{screen.fingerprint}</code> and choose Allow in the Chalk Helper app.
          </p>
          <label className="grid gap-1">
            Confirmation code shown in the app
            <input value={code} onChange={(event) => setCode(event.target.value)} dir="ltr" maxLength={19} autoComplete="off" spellCheck={false} className="rounded bg-[var(--chalk-tile)] px-2 py-1 text-[var(--chalk-text)]" />
          </label>
          <button type="submit" className="chalk-ann-btn" data-tone="primary" disabled={code.replaceAll("-", "").trim().length !== 16}>
            Confirm
          </button>
        </form>
      ) : null}
      {screen.kind === "device" ? (
        <>
          <p>
            Allow <bdi>{screen.name}</bdi> to show marks on this share?
          </p>
          {screen.fingerprint ? (
            <p>
              Confirm this fingerprint in Chalk Helper: <code dir="ltr">{screen.fingerprint}</code>
            </p>
          ) : null}
          <button type="button" className="chalk-ann-btn" data-tone="primary" onClick={() => void screen.approve()}>
            Allow this device
          </button>
        </>
      ) : null}
      {screen.kind === "status" ? <p role="status">{statuses[screen.status]}</p> : null}
      <ReconnectHelper screen={screen} enabled={Boolean(helper.challenge)} connect={connect} />
    </>
  );
}

function ReconnectHelper({ screen, enabled, connect }: { readonly screen: HelperScreen; readonly enabled: boolean; readonly connect: () => Promise<void> }) {
  const disconnected = screen.kind === "status" && screen.status === "disconnected";
  const failed = screen.kind === "code" && screen.error;
  if (!enabled || (!disconnected && !failed)) return null;
  return (
    <button type="button" className="chalk-ann-btn" data-tone="primary" onClick={() => void connect()}>
      Reconnect Chalk Helper
    </button>
  );
}

function HelperDeviceCode({ error, helper, code, setCode, lookup }: { readonly error?: string; readonly helper: ScreenAnnotationHelper; readonly code: string; readonly setCode: (value: string) => void; readonly lookup: () => Promise<void> }) {
  return (
    <>
      {error ? <p role="status">{error}</p> : null}
      {helper.lookupCode ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          {helper.deviceAccount ? (
            <label className="chalk-ann-field">
              Paste this account ID into Chalk Helper
              <input readOnly value={helper.deviceAccount} onFocus={(event) => event.currentTarget.select()} dir="ltr" className="chalk-ann-input" />
            </label>
          ) : null}
          <label className="chalk-ann-field">
            Device code from Chalk Helper
            <input value={code} onChange={(event) => setCode(event.target.value)} dir="ltr" maxLength={16} autoComplete="off" spellCheck={false} className="chalk-ann-input" />
          </label>
          <button type="submit" className="chalk-ann-btn" data-tone="primary" disabled={code.trim().length < 6}>
            Find device
          </button>
        </form>
      ) : null}
    </>
  );
}
