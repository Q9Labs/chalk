import { ChalkButton } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";
import { SignalBars } from "../participant-tile/ParticipantTile";
import type { ScreenShareState } from "./ScreenShareView";

export function ShareStatusOverlay({ status, poppedOut, name, sharedByName, onBringBack }: { readonly status: ScreenShareState; readonly poppedOut: boolean; readonly name: string; readonly sharedByName: string; readonly onBringBack: () => void }) {
  return (
    <>
      {poppedOut ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 text-center text-[var(--chalk-muted-text)]">
          <StageIcon name="pip" size={32} />
          <p className="font-medium text-[var(--chalk-text)]">{name} is in a picture-in-picture window</p>
          <ChalkButton className="!h-8 !px-3" onClick={onBringBack}>
            Bring it back
          </ChalkButton>
        </div>
      ) : null}
      {status === "connecting" ? (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--chalk-tile)] text-[var(--chalk-muted-text)]">
          <span className="h-[18px] w-[18px] rounded-[50%] border-2 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)] motion-safe:animate-spin motion-safe:[animation-duration:.9s] motion-reduce:border-t-[var(--chalk-muted-text)]" />
          <p className="font-medium text-[var(--chalk-text)]">Connecting to {sharedByName}’s screen…</p>
        </div>
      ) : null}
      {status === "paused" ? (
        <div role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-[var(--chalk-on-overlay)]">
          <span className="grid h-12 w-12 place-items-center rounded-[50%] bg-[var(--chalk-overlay-strong)]">
            <StageIcon name="pause" size={24} />
          </span>
          <p className="rounded-(--corner-lg) bg-[var(--chalk-overlay-strong)] px-3 py-1.5 font-semibold">{sharedByName} paused sharing</p>
        </div>
      ) : null}
      {status === "low-quality" ? (
        <div role="status" data-part="share-low-quality" className="absolute top-2 left-2 z-30 flex h-7 items-center gap-2 rounded-(--corner-md) bg-[var(--chalk-overlay-strong)] px-2.5 text-(length:--type-caption) font-medium text-[var(--chalk-on-overlay)]">
          <SignalBars />
          <span>{sharedByName}’s connection is slow</span>
        </div>
      ) : null}
    </>
  );
}

export function ShareError({ message }: { readonly message: string }) {
  return (
    <p role="alert" className="absolute right-2 bottom-12 left-2 z-40 rounded-md bg-[var(--chalk-overlay-strong)] p-2 text-sm text-[var(--chalk-on-overlay)]">
      {message}
    </p>
  );
}
