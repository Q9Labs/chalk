import type { PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { Loading01Icon } from "@q9labsai/chalk-react/utils";
import type { ReactNode, Ref } from "react";
import { SAFE_BOTTOM } from "./Overlay";

const strong = (text: string) => <b className="font-semibold text-[var(--chalk-text)]">{text}</b>;

/** Only exceptions get words: with everything on, the line stays empty. */
function joinNote({ microphone, camera }: PreJoinJoinOptions): ReactNode {
  if (!microphone && !camera) return <>You&rsquo;ll join with {strong("mic and camera off")}.</>;
  if (!microphone) return <>You&rsquo;ll join {strong("muted")}.</>;
  if (!camera) return <>You&rsquo;ll join with your {strong("camera off")}.</>;
  return null;
}

/** The name field, the Join button and the line that says what you join with. */
export function JoinForm({
  displayName,
  onDisplayNameChange,
  joining,
  ready,
  stacked,
  joinOptions,
  joinButton,
  onSubmit,
}: {
  readonly displayName: string;
  readonly onDisplayNameChange: (name: string) => void;
  readonly joining: boolean;
  readonly ready: boolean;
  readonly stacked: boolean;
  readonly joinOptions: PreJoinJoinOptions;
  readonly joinButton: Ref<HTMLButtonElement>;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <label htmlFor="join-display-name" className="text-(length:--type-body-sm) font-semibold">
        Your name
      </label>
      <input
        id="join-display-name"
        autoComplete="name"
        autoFocus={displayName.trim() === ""}
        readOnly={joining}
        value={displayName}
        onChange={(event) => onDisplayNameChange(event.target.value)}
        className={`h-12 w-full rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-4 text-(length:--type-body-lg) ${joining ? "text-[var(--chalk-muted-text)]" : "text-[var(--chalk-app-text)]"} outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]`}
      />
      <div className={stacked ? "sticky bottom-0 -mx-5 grid gap-2 bg-[var(--chalk-app-canvas)] px-5 pt-3" : "grid gap-2"} style={stacked ? SAFE_BOTTOM : undefined}>
        <button ref={joinButton} type="submit" data-part="pill-button" data-chalk-variant="solid" data-chalk-tone="neutral" className="chalk-pill-button mt-1 w-full" style={{ height: "var(--space-12)", fontSize: "var(--type-lead)" }} disabled={!ready} aria-busy={joining || undefined}>
          {joining ? (
            <>
              <Loading01Icon size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Joining…
            </>
          ) : (
            "Join call"
          )}
        </button>
        <p role="status" style={{ minHeight: "var(--space-5)" }} className="text-center text-(length:--type-caption) leading-snug text-[var(--chalk-muted-text)]">
          {joining ? null : joinNote(joinOptions)}
        </p>
      </div>
    </form>
  );
}
