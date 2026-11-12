// The short journeys the UI check walks on the call-state harness (apps/web/src/call-states). Each journey mounts one
// state, then performs its steps; every mount and every step is a frame that gets the layout checks and a screenshot.
// A step is `{ click: "Accessible name" }` (clicked by role and exact name) or `{ key: "Escape" }`.
// A click that changes nothing in the page is reported as a control that does nothing.

export const SIZES = [
  { id: "phone", width: 390, height: 844, mobile: true },
  { id: "tablet", width: 820, height: 1180, mobile: true },
  { id: "desktop", width: 1440, height: 900, mobile: false },
];

export const SCHEMES = ["light", "dark"];

const dock = (id, label, state, name, close = { key: "Escape" }) => ({ id, label, state, steps: [{ click: name }, close] });

export const JOURNEYS = [
  { id: "pre-join", label: "Device check before joining", page: "pre-join-states.html", state: "prejoin-default", steps: [{ click: "Microphone: MacBook Air Microphone" }, { key: "Escape" }, { click: "Turn off camera" }] },
  { id: "pre-join-blocked", label: "Device check, camera blocked", page: "pre-join-states.html", state: "prejoin-blocked", steps: [] },
  { id: "pre-join-no-mic", label: "Device check, no microphone", page: "pre-join-states.html", state: "prejoin-no-mic", steps: [] },
  { id: "pre-join-joining", label: "Joining", page: "pre-join-states.html", state: "prejoin-joining", steps: [] },
  { id: "call-1", label: "Alone in the call", state: "solo", steps: [] },
  { id: "call-2", label: "Call with 2 people", state: "duo", steps: [{ click: "Switch to grid" }, { click: "Switch to spotlight" }] },
  { id: "call-4", label: "Call with 4 people", state: "cues", steps: [] },
  { id: "call-9", label: "Call with you and 9 others, grid", state: "group-grid", steps: [] },
  { id: "call-9-spotlight", label: "Call with you and 9 others, spotlight", state: "group-spotlight", steps: [] },
  { id: "call-30", label: "Call with 30 people, paged grid", state: "crowd-grid", steps: [] },
  dock("chat", "Chat panel", "duo", "Chat"),
  dock("people", "People panel", "shell-host", "People, 8"),
  dock("details", "Call details", "duo", "Call details"),
  dock("settings", "Microphone and camera pickers", "duo", "Select microphone"),
  dock("share-options", "Share options", "duo", "Share options"),
  dock("reactions", "Reactions", "duo", "Reactions"),
  dock("more", "More options", "shell-host", "More options"),
  dock("board", "Whiteboard", "duo", "Board"),
  { id: "screen-share", label: "Screen share", state: "stage-share-two", steps: [] },
  { id: "toggles", label: "Mute and camera toggles", state: "duo", steps: [{ click: "Mute microphone" }, { click: "Turn off camera" }] },
  { id: "empty-states", label: "Cameras off", state: "cameras-off", steps: [] },
  { id: "long-names", label: "Long and right-to-left names", state: "stage-long-names", steps: [] },
  { id: "reconnecting", label: "Reconnecting", state: "conn-reconnecting", steps: [] },
  { id: "leave", label: "Leave", state: "duo", steps: [{ click: "Leave call" }] },
];
