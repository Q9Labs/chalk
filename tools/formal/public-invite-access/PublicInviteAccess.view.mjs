// Statechart view for PublicInviteAccess.tla: one guest who arrives through a Space's
// public invite, in the words of the guest and the host. A state names the arrival,
// what the host's admission queue holds, and whether the Space still takes guests.

export const title = "A guest arrives through a public invite";

const arrival = {
  none: "Guest has not arrived",
  pending: "Guest is waiting",
  admitted: "Guest is in the call",
  rejected: "Guest was turned away",
  left: "Guest left",
  unavailable: "Invite no longer works for the guest",
};

const request = {
  none: "",
  pending: ", host has not decided",
  admit_reserved: ", host said yes, Sync has not applied it",
  deny_reserved: ", host said no, Sync has not applied it",
  admitted: ", host said yes",
  denied: ", host said no",
  expired: ", request expired",
};

export const state = (v) => `${arrival[v.arr]}${request[v.sreq]}${v.archived ? ", Space archived" : ""}${v.ep === "active" ? ", call running" : ""}`;

export const group = (v) => {
  if (v.archived && v.ep === "active") return "problem";
  if (v.arr === "admitted") return "in";
  if (v.arr === "rejected" || v.arr === "left" || v.arr === "unavailable") return "out";
  return "waiting";
};

export const colors = { waiting: "yellow", in: "teal", out: "tan", problem: "pink" };

const labels = {
  Rotate: "the host rotates the invite link",
  SetInviteEnabled: "the host turns the invite on or off",
  ArrivalExpires: "the guest's arrival times out",
  RequestExpires: "the request's five minutes run out",
  LifecycleEnd: "the cleanup worker asks the call to end",
  SyncEndsEpisode: "Sync finishes ending the call",
  LifecycleArchive: "the cleanup worker archives the Space",
  HostEndsEpisode: "the host ends the call",
  Arrive: "the guest opens the invite",
  Knock: "the guest knocks",
  Decide: "the host decides",
  SyncApply: "Sync applies the host's decision",
  CollectEnds: "the guest collects a no or an expired request",
  CollectGrant: "the guest collects a yes and gets a join grant",
  CollectCommit: "the API checks the invite still holds and admits the guest",
  OpenRead: "the guest enters an open Space",
  OpenGrant: "the API joins the guest to the call",
  OpenCommit: "the API marks the guest admitted",
  LeavePending: "the waiting guest cancels",
  LeaveRevoke: "the guest leaves and Sync is told",
  LeaveFinish: "the API marks the guest as left",
  SyncLeaves: "Sync finishes the guest's leave",
  RefreshRead: "the guest asks to refresh access",
  RefreshIssue: "the API issues a fresh token",
  RefreshFails: "the API refuses the refresh",
  Done: null,
};

export const step = (action) => labels[action] ?? action;
