// Statechart view for EntryLeave.tla: the states and steps in the words of
// someone in a Chalk call who has more than one tab or device.

export const title = "Leave while another tab or device joins";

// Each participant state names its group and splits on one condition.
const phases = {
  active: {
    group: "inCall",
    when: (v) => v.issued > v.confirmed && v.issueLive,
    yes: "In the call, newer tab joining",
    no: "In the call",
  },
  leaving: {
    group: "leaving",
    when: (v) => v.issued > v.leave.entry && v.issueLive,
    yes: "Leave waits for the newer tab",
    no: "Leave finishing",
  },
  left: {
    group: "left",
    when: (v) => v.leftBy === v.confirmed,
    yes: "Left",
    no: "Left, but a newer tab joined",
  },
};

export const state = (v) => {
  const phase = phases[v.participant];
  return phase.when(v) ? phase.yes : phase.no;
};

export const group = (v) => phases[v.participant].group;

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
