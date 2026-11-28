import { ChalkSpinner } from "../chalk-ui";
import { HelperCopyButton } from "./HelperCopyButton";
import type { ScreenAnnotationHelper, ScreenAnnotationHelperStatus } from "./model";

export type HelperScreen =
  | { readonly kind: "idle" }
  | { readonly kind: "looking" }
  | { readonly kind: "attaching"; readonly fingerprint?: string }
  | { readonly kind: "confirm"; readonly fingerprint: string; readonly submit: (code: string) => void }
  | { readonly kind: "code"; readonly error?: string }
  | { readonly kind: "fingerprint"; readonly value: string; readonly approve: () => Promise<void> }
  | { readonly kind: "device"; readonly name: string; readonly fingerprint?: string; readonly approve: () => Promise<void> }
  | { readonly kind: "status"; readonly status: ScreenAnnotationHelperStatus };

const focusOnMount = (element: HTMLElement | null) => element?.focus();

/** The Helper's confirmation code is 16 characters from this alphabet, shown and typed as four groups of four. */
function groupedConfirmation(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "")
    .slice(0, 16);
  return (compact.match(/.{1,4}/g) ?? []).join("-");
}

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

function Pill({ tone, children, ...props }: { readonly tone?: "solid"; readonly children: React.ReactNode } & React.ComponentProps<"button">) {
  return (
    <button type="button" className="chalk-ann-pill" data-tone={tone} {...props}>
      {children}
    </button>
  );
}

type StepProps = Parameters<typeof HelperOfferStep>[0];
type Screen<K extends HelperScreen["kind"]> = Extract<HelperScreen, { readonly kind: K }>;

const spinner = "size-4 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)]";

function Row({ main, acts, role }: { readonly main: React.ReactNode; readonly acts?: React.ReactNode; readonly role?: "status" }) {
  return (
    <>
      <div className="chalk-pair-main" role={role}>
        {main}
      </div>
      {acts ? <div className="chalk-pair-acts">{acts}</div> : null}
    </>
  );
}

function Code({ children }: { readonly children: React.ReactNode }) {
  return (
    <code className="chalk-pair-code" dir="ltr">
      {children}
    </code>
  );
}

function InstallLink({ url }: { readonly url?: string }) {
  if (!url) return null;
  return (
    <a className="chalk-ann-pill" data-tone="solid" href={url} target="_blank" rel="noopener noreferrer">
      Get Chalk Helper
    </a>
  );
}

/** One step of the pairing row under the sharer's header: a label, one big element and one primary action. Returns nothing once marks show on the screen. */
export function HelperOfferStep(props: { readonly screen: HelperScreen; readonly guidance?: string; readonly helper: ScreenAnnotationHelper; readonly code: string; readonly setCode: (value: string) => void; readonly connect: () => Promise<void>; readonly lookup: () => Promise<void> }) {
  const { screen, helper, code, setCode, connect, lookup } = props;
  switch (screen.kind) {
    case "idle":
      return <IdleStep {...props} />;
    case "looking":
      return <Row role="status" main={<WaitLabel label="Connecting">Connecting to Chalk Helper…</WaitLabel>} />;
    case "attaching":
      return screen.fingerprint ? (
        <Row
          role="status"
          main={
            <>
              <WaitLabel label="Waiting for Chalk Helper">In Chalk Helper, press Yes, connect only if it shows</WaitLabel>
              <Code>{screen.fingerprint}</Code>
            </>
          }
        />
      ) : (
        <Row role="status" main={<WaitLabel label="Connecting">Connecting to Chalk Helper…</WaitLabel>} />
      );
    case "fingerprint":
      return (
        <Row
          main={
            <>
              <p className="chalk-pair-label">Chalk Helper should show</p>
              <Code>{screen.value}</Code>
            </>
          }
          acts={
            <Pill tone="solid" onClick={() => void screen.approve()}>
              It matches
            </Pill>
          }
        />
      );
    case "confirm":
      return <ConfirmStep screen={screen} code={code} setCode={setCode} />;
    case "code":
      return <HelperDeviceCode error={screen.error} helper={helper} code={code} setCode={setCode} lookup={lookup} reconnect={helper.challenge ? connect : undefined} />;
    case "device":
      return (
        <Row
          main={
            <>
              <p className="chalk-pair-label">
                Allow <bdi>{screen.name}</bdi> to show marks on this share?
              </p>
              {screen.fingerprint ? <Code>{screen.fingerprint}</Code> : null}
            </>
          }
          acts={
            <Pill tone="solid" onClick={() => void screen.approve()}>
              Allow this device
            </Pill>
          }
        />
      );
    case "status":
      return <StatusStep status={screen.status} helper={helper} connect={connect} />;
  }
}

function WaitLabel({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <p className="chalk-pair-label chalk-pair-wait">
      <ChalkSpinner label={label} className={spinner} />
      {children}
    </p>
  );
}

function IdleStep({ guidance, helper, connect }: StepProps) {
  const canConnect = !guidance && (helper.challenge || helper.lookupCode);
  return (
    <Row
      main={
        <>
          <p className="chalk-pair-title">See marks on your own screen</p>
          {guidance ? <p className="chalk-pair-label">{guidance}</p> : null}
        </>
      }
      acts={
        <>
          {canConnect ? <Pill onClick={() => void connect()}>I have it</Pill> : null}
          <InstallLink url={helper.installUrl} />
        </>
      }
    />
  );
}

function ConfirmStep({ screen, code, setCode }: { readonly screen: Screen<"confirm">; readonly code: string; readonly setCode: (value: string) => void }) {
  const complete = code.replaceAll("-", "").length === 16;
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete) return;
        screen.submit(code);
        setCode("");
      }}
    >
      <div className="chalk-pair-main">
        <label className="chalk-pair-label block" htmlFor="chalk-helper-confirm">
          Type the code from Chalk Helper
        </label>
        <input
          id="chalk-helper-confirm"
          ref={focusOnMount}
          value={code}
          onChange={(event) => setCode(groupedConfirmation(event.target.value))}
          dir="ltr"
          inputMode="text"
          maxLength={19}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="chalk-pair-entry"
        />
      </div>
      <div className="chalk-pair-acts">
        <button type="submit" className="chalk-ann-pill" data-tone="solid" disabled={!complete}>
          Connect
        </button>
      </div>
    </form>
  );
}

function StatusStep({ status, helper, connect }: { readonly status: ScreenAnnotationHelperStatus; readonly helper: ScreenAnnotationHelper; readonly connect: () => Promise<void> }) {
  if (status === "ready") return null;
  return (
    <Row
      role="status"
      main={<p className="chalk-pair-label">{statuses[status]}</p>}
      acts={
        <>
          {status === "update_required" ? <InstallLink url={helper.installUrl} /> : null}
          {status === "disconnected" && helper.challenge ? (
            <Pill tone="solid" onClick={() => void connect()}>
              Reconnect Chalk Helper
            </Pill>
          ) : null}
        </>
      }
    />
  );
}

function HelperDeviceCode({ error, helper, code, setCode, lookup, reconnect }: { readonly error?: string; readonly helper: ScreenAnnotationHelper; readonly code: string; readonly setCode: (value: string) => void; readonly lookup: () => Promise<void>; readonly reconnect?: () => Promise<void> }) {
  if (!helper.lookupCode)
    return (
      <>
        <div className="chalk-pair-main" role="status">
          <p className="chalk-pair-label">{error ?? "Couldn’t connect to Chalk Helper."}</p>
        </div>
        <div className="chalk-pair-acts">
          {reconnect ? (
            <Pill tone="solid" onClick={() => void reconnect()}>
              Reconnect Chalk Helper
            </Pill>
          ) : null}
        </div>
      </>
    );
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void lookup();
      }}
    >
      <div className="chalk-pair-main">
        {error ? (
          <p role="status" className="chalk-pair-label">
            {error}
          </p>
        ) : null}
        {helper.deviceAccount ? (
          <div className="chalk-pair-label flex items-center gap-2">
            <label htmlFor="chalk-helper-account">Paste this account ID into Chalk Helper</label>
            <input id="chalk-helper-account" readOnly value={helper.deviceAccount} onFocus={(event) => event.currentTarget.select()} dir="ltr" className="chalk-ann-input min-w-0 flex-1" />
            <HelperCopyButton value={helper.deviceAccount} label="Copy account ID" />
          </div>
        ) : null}
        <label className="chalk-pair-label block" htmlFor="chalk-helper-device-code">
          Device code from Chalk Helper
        </label>
        <input id="chalk-helper-device-code" value={code} onChange={(event) => setCode(event.target.value)} dir="ltr" maxLength={16} autoComplete="off" spellCheck={false} className="chalk-pair-entry" />
      </div>
      <div className="chalk-pair-acts">
        <button type="submit" className="chalk-ann-pill" data-tone="solid" disabled={code.trim().length < 6}>
          Find device
        </button>
      </div>
    </form>
  );
}
