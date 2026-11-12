// The short journeys the UI check walks on the call-state harness (apps/web/src/call-states). Each journey mounts one
// state, then performs its steps; every mount and every step is a frame that gets the layout checks and a screenshot.
// A step is `{ click: name-or-names, via? }` or `{ key: "Escape" }`. A click finds the first visible button or menu item
// whose accessible name equals one of the names; the controls differ by size (the phone folds Chat, People, Board and
// the layout switch into a "More options" sheet), so `via` names the control that opens the sheet holding the target.
// A click that changes nothing in the page is reported as a control that does nothing.

export const SIZES = [
  { id: "phone", width: 390, height: 844, mobile: true },
  { id: "tablet", width: 820, height: 1180, mobile: true },
  { id: "desktop", width: 1440, height: 900, mobile: false },
];

export const SCHEMES = ["light", "dark"];

const more = "More options";
const dock = (id, label, state, click, via, ready) => ({ id, label, state, steps: [{ click, ...(via ? { via } : {}), ...(ready ? { ready } : {}) }, { key: "Escape" }] });

export const JOURNEYS = [
  { id: "pre-join", label: "Device check before joining", page: "pre-join-states.html", state: "prejoin-default", steps: [{ click: "Microphone: MacBook Air Microphone" }, { key: "Escape" }, { click: "Turn off camera" }] },
  { id: "pre-join-blocked", label: "Device check, camera blocked", page: "pre-join-states.html", state: "prejoin-blocked", steps: [] },
  { id: "pre-join-no-mic", label: "Device check, no microphone", page: "pre-join-states.html", state: "prejoin-no-mic", steps: [] },
  { id: "pre-join-joining", label: "Joining", page: "pre-join-states.html", state: "prejoin-joining", steps: [] },
  { id: "call-1", label: "Alone in the call", state: "solo", steps: [] },
  {
    id: "call-2",
    label: "Call with 2 people",
    state: "duo",
    steps: [
      { click: ["Switch to grid", "Grid"], via: more },
      { click: ["Switch to spotlight", "Spotlight"], via: more },
    ],
  },
  { id: "call-4", label: "Call with 4 people", state: "cues", steps: [] },
  { id: "call-9", label: "Call with you and 9 others, grid", state: "group-grid", steps: [] },
  { id: "call-9-spotlight", label: "Call with you and 9 others, spotlight", state: "group-spotlight", steps: [] },
  { id: "call-30", label: "Call with 30 people, paged grid", state: "crowd-grid", sizes: ["desktop"], steps: [] },
  dock("chat", "Chat panel", "duo", "Chat", more),
  dock("people", "People panel", "shell-host", ["People, 8", "People"], more),
  dock("details", "Call details", "duo", "Call details"),
  dock("settings", "Microphone and camera pickers", "duo", ["Select microphone", "Microphone and speaker"], more),
  dock("share", "Share screen", "duo", ["Share options", "Share screen"], more),
  dock("reactions", "Reactions", "duo", "Reactions"),
  dock("more", "More options", "shell-host", more),
  dock("board", "Whiteboard", "duo", "Board", more, ".excalidraw canvas"),
  { id: "screen-share", label: "Screen share", state: "stage-share-two", ready: "button", steps: [] },
  { id: "toggles", label: "Mute and camera toggles", state: "duo", steps: [{ click: "Mute microphone" }, { click: "Turn off camera" }] },
  { id: "cameras-off", label: "Cameras off", state: "cameras-off", steps: [] },
  { id: "long-names", label: "Long and right-to-left names", state: "stage-long-names", ready: "button", steps: [] },
  { id: "reconnecting", label: "Reconnecting", state: "conn-reconnecting", steps: [] },
  { id: "notices", label: "Device notices over the board", state: "board-notices-dark", ready: ".chalk-toast", steps: [] },
  { id: "notices-join", label: "People joining with long names", state: "board-notices-light&kind=join", ready: ".chalk-toast", steps: [] },
  {
    id: "embedded",
    label: "Short call with a long name embedded in a wide host page",
    state: "board-notices-dark&notices=1&embed=300x320&name=Year%2011%20chemistry%20revision%20for%20the%20whole%20of%2011B%20with%20Ms%20Rahman%2C%20Mr%20Okafor%2C%20the%20lab%20technicians%20and%20every%20parent%20who%20asked%20to%20listen%20in",
    sizes: ["desktop"],
    ready: ".chalk-header",
    steps: [],
  },
  { id: "leave", label: "Leave", state: "duo", steps: [{ click: "Leave call" }] },
];
