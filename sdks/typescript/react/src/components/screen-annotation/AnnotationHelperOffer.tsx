import type { ScreenAnnotationClient, ScreenAnnotationState, ScreenShareCapture } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "./model";

type HelperScreen =
  | { readonly kind: "idle" | "looking" }
  | { readonly kind: "attaching"; readonly fingerprint?: string }
  | { readonly kind: "confirm"; readonly fingerprint: string; readonly submit: (code: string) => void }
  | { readonly kind: "code"; readonly error?: string }
  | { readonly kind: "fingerprint"; readonly value: string; readonly approve: () => Promise<void> }
  | { readonly kind: "device"; readonly name: string; readonly fingerprint?: string; readonly approve: () => Promise<void> }
  | { readonly kind: "status"; readonly status: ScreenAnnotationHelperStatus };

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

export function AnnotationHelperOffer({ client, state, actorId, helper, capture }: { readonly client: ScreenAnnotationClient; readonly state: ScreenAnnotationState; readonly actorId: string; readonly helper: ScreenAnnotationHelper; readonly capture?: ScreenShareCapture }) {
  const [drawing, setDrawing] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
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

  if (actorId !== state.layer.sharer_id || !drawing || dismissed) return null;
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
    if (!helper.challenge) {
      setScreen({ kind: "code" });
      return;
    }
    setScreen({ kind: "looking" });
    try {
      const response = await helper.challenge(share, controller.signal);
      if (controller.signal.aborted) return;
      if (response.kind === "update_required") setScreen({ kind: "status", status: "update_required" });
      else {
        setScreen({
          kind: "fingerprint",
          value: response.fingerprint,
          approve: () => attach(controller, (status) => response.attach(status, (signal) => new Promise<string>((resolve, reject) => {
            if (signal.aborted) { reject(signal.reason); return; }
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            setCode("");
            setScreen({ kind: "confirm", fingerprint: response.fingerprint, submit: (entered) => {
              signal.removeEventListener("abort", abort);
              resolve(entered);
            } });
          })), response.fingerprint),
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
    setDismissed(true);
  };

  return (
    <div data-part="annotation-helper-offer" className="chalk-ann-card">
      {screen.kind === "idle" ? (
        <>
          <p>
            <bdi>{drawing}</bdi> is drawing on your share. Connect Chalk Helper to see marks on your screen.
          </p>
          {helper.challenge || helper.lookupCode ? (
            <button type="button" className="chalk-ann-btn" data-tone="primary" onClick={() => void connect()}>
              Connect Chalk Helper
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
      {screen.kind === "code" ? (
        <>
          {screen.error ? <p role="status">{screen.error}</p> : null}
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
      ) : null}
      {screen.kind === "confirm" ? (
        <form className="grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          screen.submit(code);
          setCode("");
          setScreen({ kind: "attaching" });
        }}>
          <p>Match <code dir="ltr">{screen.fingerprint}</code> and choose Allow in the Chalk Helper app.</p>
          <label className="grid gap-1">
            Confirmation code shown in the app
            <input value={code} onChange={(event) => setCode(event.target.value)} dir="ltr" maxLength={19} autoComplete="off" spellCheck={false} className="rounded bg-[var(--chalk-tile)] px-2 py-1 text-[var(--chalk-text)]" />
          </label>
          <button type="submit" className="chalk-ann-btn" data-tone="primary" disabled={code.replaceAll("-", "").trim().length !== 16}>Confirm</button>
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
      <div className="chalk-ann-card-actions">
        {helper.installUrl && (screen.kind === "idle" || screen.kind === "code" || (screen.kind === "status" && screen.status === "update_required")) ? (
          <a className="chalk-ann-textbtn" href={helper.installUrl} target="_blank" rel="noopener noreferrer">
            Get Chalk Helper
          </a>
        ) : null}
        {helper.lookupCode && screen.kind !== "idle" && screen.kind !== "code" && screen.kind !== "device" && (screen.kind !== "status" || screen.status !== "ready") ? (
          <button
            type="button"
            className="chalk-ann-textbtn"
            onClick={() => {
              start();
              setScreen({ kind: "code" });
            }}
          >
            Use a device code
          </button>
        ) : null}
        <button type="button" className="chalk-ann-textbtn" onClick={dismiss}>
          {screen.kind === "status" && (screen.status === "ready" || screen.status === "device_approved") ? "Disconnect" : "Not now"}
        </button>
      </div>
    </div>
  );
}
