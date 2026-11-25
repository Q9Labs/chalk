import type { HelperScreen } from "./HelperOfferActions";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperStatus } from "./model";

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

export function HelperOfferStep({
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
