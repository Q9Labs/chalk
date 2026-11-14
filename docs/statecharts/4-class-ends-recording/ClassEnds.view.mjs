// Statechart view for ClassEnds.tla: a recorded class from running to ended
// and the recording from capture to ready.

export const title = "A recorded class ends";

export const state = (v) => {
  switch (v.call) {
    case "running":
      return v.rec === "recording" ? `Class running, recording` : `Class running, recording failed`;
    case "ending":
      return v.rec === "recording" ? `Ending the class, recording` : `Ending the class, recording failed`;
    case "ended":
      return {
        building: "Class ended, recording is being built",
        retrying: `Class ended, building failed ${v.tries} of 3 times`,
        ready: "Class ended, recording ready",
        lost: "Class ended, recording failed",
      }[v.rec];
    default:
      return v.call;
  }
};

export const group = (v) => {
  if (v.call !== "ended") return v.rec === "recording" ? "Class running" : "Recording trouble";
  return v.rec === "ready" ? "Done" : v.rec === "lost" ? "Recording trouble" : "Recording being built";
};

export const colors = { "Class running": "teal", "Recording being built": "yellow", Done: "blue", "Recording trouble": "orange" };

const labels = {
  HostPressesEnd: "the host ends the call, or the time limit arrives",
  TimeLimitArrives: "the host ends the call, or the time limit arrives",
  EndSucceeds: "everyone is removed and the call ends",
  EndGivesUp: "the call cannot be ended after 100 tries, it runs on",
  CaptureFails: "the recorder fails",
  HostRestartsRecording: "the host starts the recording again",
  BuildSucceeds: "the recording is ready",
  BuildFails: "building the recording fails",
  BuildRetries: "building starts again",
  BuildGivesUp: "the third try fails",
  Done: null,
};

export const step = (action) => (action in labels ? labels[action] : action);
