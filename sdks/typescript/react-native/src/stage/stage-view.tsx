import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useDevScenario } from "../frame/dev-scenario";

export type StageLayoutChoice = "spotlight" | "grid";

export type StageView = {
  readonly layout: StageLayoutChoice;
  readonly pinned: string | null;
  readonly boardOpen: boolean | null;
  readonly setBoardOpen: (open: boolean) => void;
  readonly following: string | null;
  readonly setFollowing: (participantId: string | null) => void;
  /** Whether your own front-camera video is mirrored, as in a mirror. On by default. */
  readonly mirror: boolean;
  readonly setLayout: (layout: StageLayoutChoice) => void;
  /** Pins a person, or unpins them if they're pinned. In Grid it switches to Spotlight first. */
  readonly togglePin: (participantId: string) => void;
  /** Spotlight with nobody pinned, so the shared screen or board takes the stage. */
  readonly showContent: () => void;
  readonly setMirror: (mirror: boolean) => void;
};

const StageViewContext = createContext<StageView | null>(null);

/**
 * The person's choices about the stage: Spotlight or Grid, who's pinned, and the mirror. They
 * live above the frame so More (the layout switch) and the stage share them.
 */
export function StageViewProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [layout, setLayout] = useState<StageLayoutChoice>("spotlight");
  const [pinned, setPinned] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState<boolean | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [mirror, setMirror] = useState(true);

  const dev = useDevScenario();
  useEffect(() => {
    if (dev.layout) setLayout(dev.layout);
    if (dev.pinned) setPinned(dev.pinned);
  }, [dev]);

  const value = useMemo<StageView>(
    () => ({
      layout,
      pinned,
      boardOpen,
      setBoardOpen,
      following,
      setFollowing,
      mirror,
      setLayout: (next) => {
        setLayout(next);
        if (next === "grid") setPinned(null);
      },
      togglePin: (participantId) => {
        if (layout === "grid") {
          setLayout("spotlight");
          setPinned(participantId);
          return;
        }
        setPinned((current) => (current === participantId ? null : participantId));
      },
      showContent: () => {
        setLayout("spotlight");
        setPinned(null);
      },
      setMirror,
    }),
    [layout, mirror, pinned, following, boardOpen],
  );
  return <StageViewContext.Provider value={value}>{children}</StageViewContext.Provider>;
}

export function useStageView(): StageView {
  const view = useContext(StageViewContext);
  if (!view) throw new Error("useStageView must be used inside <Chalk>.");
  return view;
}
