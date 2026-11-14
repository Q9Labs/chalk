// Statechart view for StartClass.tla: what a person sees from pressing
// "Start call" until they are in the call.

export const title = "A teacher presses Start call";

const callsNote = (v) => (v.rooms === 2 ? ", two calls now exist" : "");

export const state = (v) => {
  switch (v.screen) {
    case "home":
      return "Home page";
    case "starting":
      return `Starting the call${callsNote(v)}`;
    case "startFailed":
      return v.rooms === 0 ? "Start failed, no call made" : `Start failed, but a call was made${v.rooms === 2 ? " (a second one)" : ""}`;
    case "joining":
      return `Joining the call${callsNote(v)}`;
    case "joinFailed":
      return `Could not join${callsNote(v)}`;
    case "live":
      return `In the call${callsNote(v)}`;
    default:
      return v.screen;
  }
};

export const group = (v) => ({ home: "Before the call", starting: "Working", joining: "Working", startFailed: "Something failed", joinFailed: "Something failed", live: "In the call" })[v.screen];

export const colors = { "Before the call": "tan", Working: "yellow", "Something failed": "orange", "In the call": "teal" };

const labels = {
  PressStart: "you press Start call",
  RoomMade: "the call is created",
  ResponseLost: "the call is created but the answer never arrives",
  RequestRejected: "the request is refused or fails",
  JoinSucceeds: "the video connects",
  JoinFails: "the video connection fails",
  PressJoinAgain: "you press Join again",
  Done: null,
};

export const step = (action) => (action in labels ? labels[action] : action);
