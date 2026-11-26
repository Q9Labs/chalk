import { BesideScreenShareState, PreparingState, PresenterState, PresenterZoomedState, ViewerBrowsingState, ViewerFollowingState } from "./presenting";
import { Live } from "./live";
import { PEOPLE, liveSnapshot } from "./fixtures";
import type { Action, CallState } from "./states";

const nora = PEOPLE[0]!;
const openChat: Action = { click: "Chat" };

export const PRESENTING_STATES: readonly CallState[] = [
  { id: "presenting-popover", title: "Presenting: dock popover", actions: [{ click: "Present" }, { wait: 400 }], render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "presenting-presenter", title: "Presenting: presenter view", render: () => <PresenterState /> },
  { id: "presenting-presenter-thumbnails", title: "Presenting: presenter with thumbnails", actions: [{ click: "Toggle page thumbnails" }, { wait: 300 }], render: () => <PresenterState /> },
  { id: "presenting-presenter-zoomed", title: "Presenting: presenter zoomed", render: () => <PresenterZoomedState /> },
  { id: "presenting-presenter-chat", title: "Presenting: presenter with chat", actions: [openChat, { wait: 400 }], render: () => <PresenterState /> },
  { id: "presenting-viewer-following", title: "Presenting: viewer following", render: () => <ViewerFollowingState /> },
  { id: "presenting-viewer-browsing", title: "Presenting: viewer browsing ahead", actions: [{ click: "Next page" }, { click: "Next page" }], render: () => <ViewerBrowsingState /> },
  { id: "presenting-viewer-thumbnails", title: "Presenting: viewer with thumbnails", actions: [{ click: "Toggle page thumbnails" }, { wait: 300 }], render: () => <ViewerFollowingState /> },
  { id: "presenting-viewer-chat", title: "Presenting: viewer with chat", actions: [openChat, { wait: 400 }], render: () => <ViewerFollowingState /> },
  { id: "presenting-preparing", title: "Presenting: preparing", render: () => <PreparingState /> },
  { id: "presenting-beside-screenshare", title: "Presenting: document beside a screen share", render: () => <BesideScreenShareState /> },
];
