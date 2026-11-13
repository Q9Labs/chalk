// Statechart view for NetworkDrops.tla: what a student sees when their
// connection drops in the middle of a call.

export const title = "A student's connection drops during a call";

const mute = (v) => (v.debt === "owed" ? ", your mute not yet sent" : "");

export const state = (v) => {
  switch (v.screen) {
    case "live":
      return `In the call${mute(v)}`;
    case "reconnecting":
      return `Reconnecting${mute(v)}`;
    case "frozen":
      return v.seat === "held" ? "Device asleep, seat still held" : "Device asleep, seat given up";
    case "lost":
      return v.seat === "held" ? "Connection lost, seat still held" : "Connection lost, seat given up";
    case "left":
      return v.pressedLeave ? "You left (you pressed Leave)" : "You left (you did not press Leave)";
    default:
      return v.screen;
  }
};

const groups = {
  live: "In the call",
  reconnecting: "Reconnecting",
  frozen: "Away",
  lost: "Away",
  left: "Out of the call",
};

export const group = (v) => groups[v.screen];

export const colors = { "In the call": "teal", Reconnecting: "yellow", Away: "tan", "Out of the call": "orange" };

const labels = {
  ConnectionDrops: "the connection drops",
  RecoveryGivesUp: "60 seconds pass without a connection",
  ConnectionReturns: "the connection comes back",
  PageFreezes: "the device goes to sleep",
  SeatExpires: "2 minutes pass and the server gives up your seat",
  PageWakes: "the device wakes up",
  PressLeave: "you press Leave",
  PressMicOff: "you turn your microphone off",
  PayMuteDebt: "the page tells the call your microphone is off",
  Done: null,
};

export const step = (action) => (action in labels ? labels[action] : action);
