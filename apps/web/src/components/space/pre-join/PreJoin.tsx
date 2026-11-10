import { usePreJoinDevices, type PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { Loading01Icon } from "@q9labsai/chalk-react/utils";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessCard, type AccessReason } from "./AccessCard";
import { DeviceRows, DevicesSheetRow } from "./DeviceRows";
import { BottomSheet } from "./Overlay";
import { PreviewTile } from "./PreviewTile";

const STACKED = "(max-width: 899px)";

/** One column on phones and tablets, two columns when the preview and the form fit side by side. */
function useStacked(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = globalThis.matchMedia?.(STACKED);
      query?.addEventListener("change", change);
      return () => query?.removeEventListener("change", change);
    },
    () => globalThis.matchMedia?.(STACKED).matches ?? false,
    () => false,
  );
}

/** Only exceptions get words: with everything on, the line stays empty. */
function joinNote({ microphone, camera }: PreJoinJoinOptions): ReactNode {
  if (!microphone && !camera)
    return (
      <>
        You&rsquo;ll join with <b className="font-semibold text-[var(--chalk-text)]">mic and camera off</b>.
      </>
    );
  if (!microphone)
    return (
      <>
        You&rsquo;ll join <b className="font-semibold text-[var(--chalk-text)]">muted</b>.
      </>
    );
  if (!camera)
    return (
      <>
        You&rsquo;ll join with your <b className="font-semibold text-[var(--chalk-text)]">camera off</b>.
      </>
    );
  return null;
}

export type PreJoinProps = {
  readonly spaceName?: string;
  readonly displayName: string;
  readonly onDisplayNameChange: (name: string) => void;
  /** The visitor pressed Join: fields lock and the preview keeps running until the call replaces this step. */
  readonly joining: boolean;
  readonly onJoin: (devices: PreJoinJoinOptions) => void;
};

/** The step before the call: see yourself, hear yourself, press Join. */
export function PreJoin({ spaceName, displayName, onDisplayNameChange, joining, onJoin }: PreJoinProps) {
  const devices = usePreJoinDevices();
  const stacked = useStacked();
  const [dismissed, setDismissed] = useState(false);
  const { access } = devices;
  const reason: AccessReason | null = dismissed || joining ? null : access === "blocked" ? "blocked" : access === "ask" || access === "requesting" ? "ask" : null;
  const named = displayName.trim() !== "";
  const ready = named && !joining && access !== "checking" && access !== "requesting";
  // Join is disabled while the browser's permission is read, so it takes focus the first time it can: Enter then joins.
  const joinButton = useRef<HTMLButtonElement>(null);
  const focusedJoin = useRef(false);
  useEffect(() => {
    if (!ready || focusedJoin.current || document.activeElement !== document.body) return;
    focusedJoin.current = true;
    joinButton.current?.focus();
  }, [ready]);
  const askAgain = () => setDismissed(false);
  const toggle = (device: "microphone" | "camera") => {
    if (access !== "granted") return askAgain();
    if (device === "microphone") devices.setMicrophoneOn(!devices.microphoneOn);
    else devices.setCameraOn(!devices.cameraOn);
  };
  const card = reason ? <AccessCard reason={reason} requesting={access === "requesting"} onDismiss={() => setDismissed(true)} onAllow={devices.requestAccess} /> : null;

  const title = <h1 className="text-(length:--type-headline) font-semibold leading-[1.15]">{spaceName ?? "Join the call"}</h1>;
  const preview = (
    <PreviewTile devices={devices} displayName={displayName} locked={joining} dimmed={reason !== null} onToggle={toggle}>
      {card && !stacked ? <div className="absolute left-1/2 top-1/2 z-10 w-80 -translate-x-1/2 -translate-y-1/2 rounded-[var(--corner-3xl)] border border-[var(--chalk-line-strong)] bg-[var(--chalk-popover)] shadow-[var(--chalk-shadow)]">{card}</div> : null}
    </PreviewTile>
  );
  const rows = stacked ? <DevicesSheetRow devices={devices} locked={joining} onNeedAccess={askAgain} /> : <DeviceRows devices={devices} locked={joining} onNeedAccess={askAgain} />;
  const form = (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onJoin(devices.commit());
      }}
    >
      <label htmlFor="join-display-name" className="text-(length:--type-body-sm) font-semibold">
        Your name
      </label>
      <input
        id="join-display-name"
        autoComplete="name"
        autoFocus={!named}
        readOnly={joining}
        value={displayName}
        onChange={(event) => onDisplayNameChange(event.target.value)}
        className="h-12 w-full rounded-[var(--corner-xl)] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-4 text-(length:--type-body-lg) text-[var(--chalk-app-text)] outline-none read-only:text-[var(--chalk-muted-text)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
      />
      <div className={stacked ? "sticky bottom-0 -mx-5 grid gap-2 bg-[var(--chalk-app-canvas)] px-5 pb-[max(env(safe-area-inset-bottom),var(--space-6))] pt-3" : "grid gap-2"}>
        <button ref={joinButton} type="submit" data-part="pill-button" data-chalk-variant="solid" data-chalk-tone="neutral" className="chalk-pill-button mt-1 !h-12 w-full !text-(length:--type-lead)" disabled={!ready} aria-busy={joining || undefined}>
          {joining ? (
            <>
              <Loading01Icon size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Joining…
            </>
          ) : (
            "Join call"
          )}
        </button>
        <p role="status" className="min-h-[18px] text-center text-(length:--type-caption) leading-[1.45] text-[var(--chalk-muted-text)]">
          {joining ? null : joinNote(devices.joinOptions)}
        </p>
      </div>
    </form>
  );

  const sheet =
    card && stacked ? (
      <BottomSheet label="Camera and microphone" onClose={() => setDismissed(true)}>
        {card}
      </BottomSheet>
    ) : null;
  if (stacked)
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--chalk-app-canvas)] px-5 pt-6 text-[var(--chalk-app-text)]">
        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-3">
          {title}
          {preview}
          {rows}
          <div className="mt-auto">{form}</div>
        </div>
        {sheet}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto bg-[var(--chalk-app-canvas)] px-6 py-10 text-[var(--chalk-app-text)]">
      <div className="m-auto grid grid-cols-[600px_320px] items-start gap-14">
        <div className="grid gap-3">
          {preview}
          {rows}
        </div>
        <div className="grid h-[338px] content-center gap-5">
          {title}
          {form}
        </div>
      </div>
    </div>
  );
}
