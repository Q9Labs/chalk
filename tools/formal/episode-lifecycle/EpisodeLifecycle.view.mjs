// Statechart view for EpisodeLifecycle.tla: one person and one Episode, in the
// words of someone who joins a Chalk call whose host or time limit can end it.
// Draw it with one person and MaxGen = 1 so the chart stays small.

export const title = "One person in an Episode that a host or the time limit can end";

const episodeStates = (v) => {
  if (v.ep === "ended") return "Ended";
  if (v.ep === "ending") return v.endOp.kind === "max" ? "Ending, time limit passed" : "Ending, host pressed End";
  if (!v.due) return "Running";
  return "Past time limit";
};

// The chart uses one person, so each per-person function has one value.
const only = (byPerson) => Object.values(byPerson)[0];

const personStates = (v) => {
  const status = only(v.ps);
  if (status === "none") return "Not joined";
  if (status === "joining") return only(v.adm) === "pending" ? "Knocking, waiting for a host" : "Joining";
  if (status === "active") return "In the call";
  if (status === "leaving") return "Leaving";
  return "Left";
};

export const state = (v) => ({ Episode: episodeStates(v), You: personStates(v) });

export const group = (v) => {
  if (v.ep === "ended") return "ended";
  if (v.ep === "ending") return "ending";
  return v.due ? "late" : "running";
};

export const colors = { running: "teal", late: "yellow", ending: "orange", ended: "purple" };

const labels = {
  AdmitParticipant: "you join",
  RequestKnock: "you knock",
  ApplyJoin: "you are let in",
  ReserveDecision: null,
  ReleaseDecision: null,
  AcceptLeave: "you press Leave",
  FinalizeLeave: "your Leave finishes",
  FailLeave: "your Leave fails",
  SettleObsoleteLeave: null,
  DeadlineDue: "the time limit passes",
  SetDeadline: "a host extends the time limit",
  FinalizeDeadline: "the new time limit starts",
  EnqueueMaximumDuration: "the scheduler starts the time-limit end",
  AcceptUserEnd: "a host presses End",
  CompleteEnd: "the Episode ends",
  RejectStaleEnd: "the old time-limit end is dropped",
  EndRetriesExhausted: "the end fails after 100 tries",
  Done: null,
};

export const step = (action, from, to) => {
  if (action === "FinalizeDecision") {
    const answer = only(to.adm);
    if (answer === "admitted") return "a host lets you in";
    if (answer === "denied") return "a host turns you away";
    return "your knock times out";
  }
  return labels[action] ?? action;
};
