import { usePreJoinDevices, type PreJoinAccess, type PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessCard, type AccessReason } from "./AccessCard";
import { DeviceRows, DevicesSheetRow } from "./DeviceRows";
import { JoinForm } from "./JoinForm";
import { BottomSheet } from "./Overlay";
import { PreviewTile } from "./PreviewTile";

const STACKED = "(max-width: 1023px)";

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

export type PreJoinProps = {
  readonly spaceName?: string;
  readonly displayName: string;
  readonly onDisplayNameChange: (name: string) => void;
  /** The visitor pressed Join: fields lock and the preview keeps running until the call replaces this step. */
  readonly joining: boolean;
  readonly onJoin: (devices: PreJoinJoinOptions) => void;
};

function accessReason(access: PreJoinAccess): AccessReason | null {
  if (access === "blocked") return "blocked";
  return access === "ask" || access === "requesting" ? "ask" : null;
}

/** Join is disabled while the browser's permission is read, so it takes focus the first time it can: Enter then joins. */
function useFocusWhenReady(ready: boolean) {
  const joinButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!ready || focused.current || document.activeElement !== document.body) return;
    focused.current = true;
    joinButton.current?.focus();
  }, [ready]);
  return joinButton;
}

type LayoutParts = { readonly title: ReactNode; readonly preview: ReactNode; readonly rows: ReactNode; readonly form: ReactNode; readonly sheet: ReactNode };

function StackedLayout({ title, preview, rows, form, sheet }: LayoutParts) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--chalk-app-canvas)] px-5 pt-6 text-[var(--chalk-app-text)]">
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-3">
        {title}
        {preview}
        {rows}
        <div className="flex flex-1 flex-col justify-end">{form}</div>
      </div>
      {sheet}
    </div>
  );
}

function SideBySideLayout({ title, preview, rows, form }: LayoutParts) {
  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto bg-[var(--chalk-app-canvas)] px-6 py-10 text-[var(--chalk-app-text)]">
      <div className="m-auto grid items-start gap-14" style={{ gridTemplateColumns: "600px 320px" }}>
        <div className="grid gap-3">
          {preview}
          {rows}
        </div>
        <div className="flex h-[338px] flex-col justify-center gap-5">
          {title}
          {form}
        </div>
      </div>
    </div>
  );
}

/** The step before the call: see yourself, hear yourself, press Join. */
export function PreJoin({ spaceName, displayName, onDisplayNameChange, joining, onJoin }: PreJoinProps) {
  const devices = usePreJoinDevices();
  const stacked = useStacked();
  const [dismissed, setDismissed] = useState(false);
  const { access } = devices;
  const reason = dismissed || joining ? null : accessReason(access);
  // A visitor who dismissed the card while the browser prompt is still open can join with devices off.
  const ready = displayName.trim() !== "" && !joining && access !== "checking" && (access !== "requesting" || dismissed);
  const joinButton = useFocusWhenReady(ready);
  const askAgain = () => setDismissed(false);
  const toggle = (device: "microphone" | "camera") => {
    if (access !== "granted") return askAgain();
    if (device === "microphone") devices.setMicrophoneOn(!devices.microphoneOn);
    else devices.setCameraOn(!devices.cameraOn);
  };
  const card = reason ? <AccessCard reason={reason} requesting={access === "requesting"} onDismiss={() => setDismissed(true)} onAllow={devices.requestAccess} /> : null;
  const parts: LayoutParts = {
    title: <h1 className="text-(length:--type-headline) font-semibold leading-snug">{spaceName ?? "Join the call"}</h1>,
    preview: (
      <PreviewTile devices={devices} displayName={displayName} locked={joining} dimmed={reason !== null} onToggle={toggle}>
        {card && !stacked ? <div className="absolute left-1/2 top-1/2 z-10 w-80 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[var(--chalk-line-strong)] bg-[var(--chalk-popover)]">{card}</div> : null}
      </PreviewTile>
    ),
    rows: stacked ? <DevicesSheetRow devices={devices} locked={joining} onNeedAccess={askAgain} /> : <DeviceRows devices={devices} locked={joining} onNeedAccess={askAgain} />,
    form: <JoinForm displayName={displayName} onDisplayNameChange={onDisplayNameChange} joining={joining} ready={ready} stacked={stacked} joinOptions={devices.joinOptions} joinButton={joinButton} onSubmit={() => onJoin(devices.commit())} />,
    sheet:
      card && stacked ? (
        <BottomSheet label="Camera and microphone" onClose={() => setDismissed(true)}>
          {card}
        </BottomSheet>
      ) : null,
  };
  return stacked ? <StackedLayout {...parts} /> : <SideBySideLayout {...parts} />;
}
