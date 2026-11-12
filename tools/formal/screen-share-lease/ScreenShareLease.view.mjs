// Statechart view for ScreenShareLease.tla: two people in one Episode who both
// want to share their screen. Draw it with small bounds so the chart stays
// small: Horizon = 2, Renew = 2, Hard = 3, Every = 3, MaxSeq = 2, MaxLid = 2.

export const title = "Two people who both want to share a screen in one Episode";

const names = { p1: "First", p2: "Second" };

const leaseLive = (db, now) => db.held && Math.min(db.ru, db.hu) > now;

const leaseState = (v) => {
  if (!v.db.held) return "No lease";
  return `Held by ${names[v.db.owner]}, ${leaseLive(v.db, v.now) ? "running" : "lapsed"}`;
};

const personState = (v, p) => {
  const inCall = v.auth[p] > 0;
  const sharing = v.pub.includes(p);
  if (!inCall) return sharing ? "Left, share still at the media plane" : "Not in the call";
  if (!sharing) return "In the call";
  return v.mem[p].lid > 0 ? "Sharing, holds a lease" : "Sharing, lease forgotten";
};

export const state = (v) => ({
  First: personState(v, "p1"),
  Second: personState(v, "p2"),
  Lease: leaseState(v),
});

const sharers = (v) => v.pub.filter((p) => v.auth[p] > 0).length;

export const group = (v) => (sharers(v) >= 2 ? "two" : sharers(v) === 1 ? "one" : "none");

export const colors = { none: "teal", one: "yellow", two: "orange" };

const labels = {
  Tick: "5 seconds pass",
  Join: "someone joins",
  Leave: "someone leaves",
  ClientStops: "someone stops sharing",
  Conflict: "the media plane reports two shares, the pass stops",
  Look: "the media plane is looked at again, nothing new",
  StopCommand: "the app switches sharing off",
};

export const step = (action, from, to) => {
  if (action === "EnableScreen") {
    if (from.pub.length < to.pub.length) return "the app starts sharing";
    return to.db.held
      ? "the share is refused and the lease release fails, so the lease stays"
      : "the share is refused and the lease is released";
  }
  if (action === "Observe") return "the media plane reports a change";
  return labels[action] ?? action;
};
