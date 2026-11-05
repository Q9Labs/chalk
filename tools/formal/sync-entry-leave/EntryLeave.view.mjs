// Statechart view for EntryLeave.tla: the states and steps in the words of
// someone in a Chalk call who has more than one tab or device.

const defers = (v) => v.issued > v.leave.entry && v.issueLive;

export const title = "Leave while another tab or device joins";

export const state = (v) => {
  if (v.participant === "left") {
    return v.leftBy === v.confirmed ? "Left" : "Left, but a newer tab joined";
  }
  if (v.participant === "leaving") {
    return defers(v) ? "Leave waits for the newer tab" : "Leave finishing";
  }
  return v.issued > v.confirmed && v.issueLive ? "In the call, newer tab joining" : "In the call";
};

export const group = (v) => {
  if (v.participant === "left") return "left";
  if (v.participant === "leaving") return "leaving";
  return "inCall";
};

export const colors = { inCall: "teal", leaving: "yellow", left: "purple" };

const labels = {
  AdmitNewEntry: "another tab or device connects",
  IssueLeaseExpires: "the newer tab's 2 minutes run out",
  ClaimEntry: "a newer tab finishes joining",
  AcceptLeave: "you press Leave",
  ConsumerClaim: "Sync picks up the Leave",
  ConsumerPrepare: "Sync picks up the Leave",
  ConsumerFinalize: "Sync finishes the Leave",
  ConsumerAbandons: null,
  Done: null,
};

export const step = (action) => labels[action] ?? action;
