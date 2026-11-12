// Statechart view for ExternalOperations.tla (role transitions): the states and
// steps in the words of a host who changes a speaker's role while the speaker
// is, or is about to be, publishing a microphone.

export const title = "Taking publishing away from a speaker";

const stopWords = {
  none: "",
  pending: ", mic stop waiting",
  applied: ", mic stop done",
  failed: ", mic stop given up",
};

const request = (v) => {
  if (v.res === "pending" || v.res === "ambiguous") {
    return v.resExp ? ", mic request expired" : ", mic request open";
  }
  return v.res === "failed" ? ", mic request refused" : "";
};

export const state = (v) => {
  const role = v.cap ? "Can publish" : "Cannot publish";
  const mic = v.pState === "granted" ? "mic live" : "mic off";
  return `${role}, ${mic}${request(v)}${stopWords[v.st.rt]}`;
};

export const group = (v) => {
  if (v.cap) return "speaker";
  if (v.st.rt === "pending") return "cleanup";
  return "settled";
};

export const colors = { speaker: "teal", cleanup: "yellow", settled: "purple" };

export const step = (action, from, to) => {
  switch (action) {
    case "Reserve":
      return "the speaker asks for the mic";
    case "ResendGrant":
      return "the mic request is sent again";
    case "SendGrant":
      return "the request goes to the SFU";
    case "DeliverGrant":
      return to.pState === "granted" ? "the SFU turns the mic on" : "the SFU refuses the request";
    case "LiveDies":
      return "the request handler stops";
    case "ExpireReservation":
      return "the request's 30 seconds run out";
    case "CompleteGrant":
      return from.st.rt === "pending" && to.st.rt === "applied" ? "a refused request closes the mic stop" : "the request is recorded";
    case "RoleDemote":
      return to.st.rt === "none" ? "a host takes publishing away [no mic seen, no open request]" : "a host takes publishing away";
    case "RolePromote":
      return "a host gives publishing back";
    case "FenceExpires":
      return "the 5-minute hold runs out";
    case "Claim":
      return "Sync picks up the mic stop";
    case "ClaimLeaseExpires":
      return "Sync's 60 seconds run out";
    case "NodeCalls":
      return "Sync asks the SFU to switch the mic off";
    case "ProviderRuns":
      return to.pState === "revoked" ? "the SFU switches the mic off" : "the SFU ignores a stale stop";
    case "NodeHears":
      return "Sync waits for the SFU's answer";
    case "NodeFinalizes":
      return "Sync closes the mic stop";
    case "NodePending":
      return to.st.rt === "failed" ? "Sync gives up after its retries" : "Sync gets no clear answer";
    case "NodeStops":
      return "the Sync node stops";
    default:
      return action;
  }
};
