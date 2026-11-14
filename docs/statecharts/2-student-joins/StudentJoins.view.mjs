// Statechart view for StudentJoins.tla: what a student sees from opening an
// invite link until they are in the call.

export const title = "A student opens an invite link";

export const state = (v) => {
  switch (v.screen) {
    case "link":
      return "Invite link opened";
    case "waiting":
      return "Waiting for the host to let you in";
    case "joining":
      return "Joining the call";
    case "live":
      return "In the call";
    case "declined":
      return "Host declined your request";
    case "unavailable":
      return v.cause === "opened" ? "Request expired, the host just opened the room" : "Request expired";
    case "returning":
      return "Page reloaded, returning to the call";
    case "returnFailed":
      return "Could not return, seat is open elsewhere";
    case "dead":
      return "Invite link no longer works";
    default:
      return v.screen;
  }
};

const groups = {
  link: "Before the call",
  waiting: "Waiting",
  joining: "Joining",
  live: "In the call",
  returning: "Joining",
  declined: "Turned away",
  unavailable: "Turned away",
  returnFailed: "Turned away",
  dead: "Turned away",
};

export const group = (v) => groups[v.screen];

export const colors = { "Before the call": "tan", Waiting: "blue", Joining: "yellow", "In the call": "teal", "Turned away": "orange" };

const labels = {
  PressJoin: "you press Join",
  HostLetsIn: "the host lets you in",
  HostDeclines: "the host declines",
  HostOpensRoom: "the host opens the room to everyone",
  HostChangesLink: "the host replaces the invite link",
  WaitTimesOut: "the request times out",
  PressJoinAgain: "you press Join again",
  VideoConnects: "the video connects",
  ConnectFails: null,
  ReloadSoon: "you reload the page [within 2 minutes]",
  ReloadLate: null,
  ReturnSucceeds: "the call takes you back",
  ReturnRefused: "the call refuses your old seat",
  Done: null,
};

export const step = (action) => (action in labels ? labels[action] : action);
