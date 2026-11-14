// Statechart view for ClientRecovery.tla: the states and steps in the words of
// someone in a Chalk call whose connection drops and comes back.

export const title = "Your connection in a Chalk call: drops, recovery, Leave";

const linkDown = (v) => v.syncP !== "live" || v.mediaP !== "live";

// Each state names its group and the sentence a person would say about it.
export const state = (v) => {
  switch (v.conn) {
    case "idle":
      return "Not in a call yet";
    case "joining":
      return "Joining";
    case "live":
      if (v.grant === "expired") return "In the call, access has run out";
      if (v.rq !== "none" || linkDown(v)) return "In the call, a link just dropped";
      return "In the call";
    case "reconnecting":
      if (v.syncDead) return "Reconnecting, call link gone for good";
      return v.rq === "sync" ? "Reconnecting, call link down" : "Reconnecting, audio and video down";
    case "leaving":
      if (v.restartInLeave) return "Leaving, recovery reached for a new connection";
      return v.fib !== "none" ? "Leaving, recovery still running" : "Leaving";
    case "left":
      if (v.removedByHost) return "Removed by the host";
      return v.endObserved ? "Call ended" : "Left";
    default:
      return "Connection lost";
  }
};

export const group = (v) => {
  switch (v.conn) {
    case "live":
      return v.rq !== "none" || linkDown(v) || v.grant === "expired" ? "recovering" : "inCall";
    case "joining":
      return "joining";
    case "reconnecting":
      return "recovering";
    case "leaving":
      return "leaving";
    case "failed":
      return "failed";
    default:
      return "over";
  }
};

export const colors = { joining: "blue", inCall: "teal", recovering: "yellow", leaving: "tan", over: "purple", failed: "pink" };

const labels = {
  UserJoin: "you press Join",
  ProcessJoin: "you join the call",
  JoinSucceeds: "joining finishes",
  JoinFails: "joining fails",
  UserLeave: "you press Leave",
  ProcessLeave: "the app starts to Leave",
  LeaveEnds: "Leave finishes",
  ProcessRec: "the link stays down after a moment",
  FiberGrace: "the quiet moment ends",
  PlanCycle: "recovery starts a try",
  AttemptSeesSync: "recovery sees the call link live",
  AttemptSeesMedia: "recovery sees audio and video live",
  AttemptRestartMedia: "recovery restarts audio and video",
  AttemptRestartSync: "recovery replaces the call link",
  ProcessRest: "the call link is replaced",
  AttemptSucceeds: "recovery sees both links live",
  AttemptFatal: "recovery meets a failure it cannot fix",
  AttemptExhausted: "recovery runs out of tries",
  AfterExh: "recovery pauses before the next try",
  BackoffWakes: "recovery tries again",
  ProcessFin: "recovery finishes",
  ProcessFail: "recovery gives up",
  RefreshStarts: "the app starts to refresh your access",
  RefreshReturns: "the refresh answers",
  SyncDrops: "the call link drops",
  SyncDies: "the call link dies for good",
  SyncTerminates: "Sync closes the call link",
  SyncDials: "the call link dials",
  SyncWelcome: "the call link comes back",
  MediaConnects: "audio and video connect",
  MediaDrops: "audio and video drop",
  MediaFails: "audio and video fail to reconnect",
  MediaHeals: "audio and video come back",
};

export const step = (action, from, to) => {
  switch (action) {
    case "ProcessSnapS":
      if (to.conn === "left") return to.removedByHost && !from.removedByHost ? "the host removes you" : "the call ends";
      if (to.conn === "failed") return "Sync rejects your access";
      return "the app sees the call link is down";
    case "ProcessSnapM":
      return "the app sees audio and video are down";
    case "GrantAges":
      return to.grant === "expired" ? "your access grant runs out" : "your access grant needs a refresh";
    case "ProcessRefr":
      return to.conn === "failed" ? "the server rejects your access" : "the access refresh returns";
    case "ProcessExh":
      if (to.conn === "failed") return "recovery runs out of time with the call link down";
      return to.rq !== from.rq ? "recovery runs out of time, the call link is back" : "recovery runs out of time";
    default:
      return labels[action] ?? action;
  }
};
