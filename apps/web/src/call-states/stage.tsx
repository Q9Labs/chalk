import { useEffect, useMemo, useState } from "react";
import { ChalkButton } from "@q9labsai/chalk-react";
import { SpaceStage } from "../../../../sdks/typescript/react/src/components/stage/SpaceStage";
import { SpacePresentation } from "../../../../sdks/typescript/react/src/components/space-view/SpacePresentation";
import type { Participant } from "../../../../sdks/typescript/react/src/components/participant-grid/ParticipantGrid";
import type { ScreenShareState } from "../../../../sdks/typescript/react/src/components/composite/ScreenShareView";
import { cameraTrack } from "./media";
import type { CallState } from "./states";

type Share = "none" | "remote" | "local" | "two";
interface StageFixtureProps {
  readonly count?: number;
  readonly theme?: "dark" | "light";
  readonly layout?: "focus" | "grid";
  readonly share?: Share;
  readonly aspect?: number;
  readonly shareState?: ScreenShareState;
  readonly cameras?: boolean;
}
const NAMES = ["You", "Nora", "Akash", "Sofia", "Malik", "Priya", "Eli", "June", "Tomás", "Lena", "Kenji", "Amara"];

function useScreenTrack(aspect: number): MediaStreamTrack | null {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.height = 720;
    canvas.width = Math.round(canvas.height * aspect);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The stage fixture requires Canvas 2D.");
    context.fillStyle = "#f7f6f2";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0c0e12";
    context.font = "700 60px sans-serif";
    context.fillText("Q4 plan", 50, 100);
    context.font = "30px sans-serif";
    ["Ship the foundation", "Review together", "Keep it simple"].forEach((text, index) => context.fillText(text, 50, 200 + index * 80));
    const stream = canvas.captureStream(4);
    const video = stream.getVideoTracks()[0];
    if (!video) throw new Error("The stage fixture produced no screen track.");
    const timer = setInterval(() => { context.fillStyle = "#f7f6f2"; context.fillRect(canvas.width - 2, 0, 2, 2); }, 250);
    setTrack(video);
    return () => { clearInterval(timer); video.stop(); };
  }, [aspect]);
  return track;
}

/** The actual frame and stage, with deterministic media and observable roster/share controls. */
export function StageFixture({ count: initialCount = 6, theme = "dark", layout: initialLayout = "focus", share: initialShare = "none", aspect = 16 / 9, shareState = "live", cameras = true }: StageFixtureProps) {
  const [count, setCount] = useState(initialCount);
  const [layout, setLayout] = useState(initialLayout);
  const [share, setShare] = useState(initialShare);
  const [people, setPeople] = useState(false);
  const track = useScreenTrack(aspect);
  const tiles = useMemo<Participant[]>(() => Array.from({ length: count }, (_, index) => ({
    id: `stage-${index}`, displayName: NAMES[index] ?? `Guest ${index + 1}`, isLocal: index === 0, isMuted: index === 2,
    isVideoEnabled: cameras, videoTrack: cameras ? cameraTrack(`stage-${index}`, "#4d5d73") : null,
    isSpeaking: index === 1, isActiveSpeaker: index === 1, isHandRaised: index === 5, handRaiseOrder: index === 5 ? 1 : undefined,
    connectionQuality: index === 4 ? 1 : 4, isScreenSharing: share === "local" ? index === 0 : share === "two" ? index === 1 || index === 2 : share === "remote" && index === 1,
    screenShareTrack: track, screenShareHasAudio: true, screenShareAspect: aspect, screenShareState: shareState,
  })), [count, cameras, share, track, aspect, shareState]);
  return <SpacePresentation colorScheme={theme} stageBackground header={{ spaceName: "Team", layout, onLayoutChange: setLayout }}
    stage={<SpaceStage tiles={tiles} layout={layout} onLayoutChange={setLayout} onOverflowClick={() => setPeople(true)} shareCapture={{ surface: "monitor", label: "Entire screen" }} onStopSharing={async () => setShare("none")} onChangeShare={async () => setShare("local")} />}
    controls={<div className="flex items-center gap-2"><ChalkButton onClick={() => setLayout(layout === "grid" ? "focus" : "grid")}>{layout === "grid" ? "Spotlight" : "Grid"}</ChalkButton><ChalkButton onClick={() => setShare(share === "none" ? "remote" : "none")}>{share === "none" ? "Start fixture share" : "Stop fixture share"}</ChalkButton><ChalkButton onClick={() => setCount(value => value + 1)}>Add participant</ChalkButton><ChalkButton onClick={() => setCount(value => Math.max(1, value - 1))}>Remove participant</ChalkButton><ChalkButton onClick={() => setPeople(!people)}>People</ChalkButton></div>}
    sidebar={people ? <aside className="chalk-drawer" data-state="open" aria-label="People"><button onClick={() => setPeople(false)}>Close People</button>{tiles.map(tile => <p key={tile.id}>{tile.displayName}</p>)}</aside> : undefined} />;
}

export const STAGE_STATES: readonly CallState[] = [
  ...[3, 5, 6, 7, 12, 30].map(count => ({ id: `stage-grid-${count}`, title: `${count} people in justified Grid`, render: () => <StageFixture count={count} layout="grid" /> })),
  { id: "stage-spotlight", title: "Spotlight", render: () => <StageFixture /> },
  { id: "stage-duo", title: "Two-person phone picture-in-picture", render: () => <StageFixture count={2} /> },
  { id: "stage-avatars", title: "Bold speaking Facehash tiles", render: () => <StageFixture cameras={false} layout="grid" /> },
  { id: "stage-share-grid", title: "Double-width screen in Grid", render: () => <StageFixture share="remote" layout="grid" /> },
  ...[9 / 16, 4 / 3, 16 / 9, 21 / 9].map((aspect, index) => ({ id: `stage-share-aspect-${index}`, title: `Content-aware Spotlight ${aspect}`, render: () => <StageFixture share="remote" aspect={aspect} /> })),
  ...(["connecting", "paused", "low-quality"] as const).map(shareState => ({ id: `stage-share-${shareState}`, title: `Screen ${shareState}`, render: () => <StageFixture share="remote" shareState={shareState} /> })),
  { id: "stage-share-two", title: "Two simultaneous sharers", render: () => <StageFixture share="two" /> },
  { id: "stage-share-local", title: "Your live screen preview", render: () => <StageFixture share="local" /> },
  { id: "stage-light", title: "Grid in Light", render: () => <StageFixture layout="grid" theme="light" /> },
  { id: "stage-share-light", title: "Share in Light", render: () => <StageFixture share="remote" theme="light" /> },
];
