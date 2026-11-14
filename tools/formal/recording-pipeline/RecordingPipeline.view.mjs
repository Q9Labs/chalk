// Statechart view for RecordingPipeline.tla: the states and steps in the words of
// a host who records a Chalk call. Each state names what the host sees in the call
// and what the recording service is doing behind it.

export const title = "Recording a call, from Sync to the capture nodes";

const seen = {
  none: "No recording",
  starting: "Recording starting",
  recording: "Recording",
  stopping: "Recording stopping",
  stopped: "Recording stopped",
  failed: "Recording failed",
};

const behind = {
  none: "no capture yet",
  reserved: "waiting for a capture node",
  leased: "a node is joining",
  capturing: "a node is capturing",
  retryable: "capture needs a new node",
  complete: "capture done",
  rendering: "rendering",
  committed: "saved",
  terminal: "capture gave up",
};

export const state = (v) => `${v.ep === "ended" ? "Call over: " : v.ep === "ending" ? "Call ending: " : ""}${seen[v.rec]}, ${behind[v.pipe]}`;

export const group = (v) => {
  if (v.pipe === "terminal" || v.rec === "failed") return "failed";
  if (v.pipe === "complete" || v.pipe === "rendering" || v.pipe === "committed") return "done";
  if (v.rec === "stopping" || v.rec === "stopped") return "stopping";
  return "running";
};

export const colors = { running: "teal", stopping: "yellow", done: "purple", failed: "pink" };

const labels = {
  AcceptStart: "you press Record",
  DispatchStart: "Sync asks the recording service for a slot",
  CaptureReadyFact: "capture starts and Sync hears about it",
  CaptureFailedFact: "the recording service tells Sync it gave up",
  AcceptManualStop: "you press Stop",
  DispatchManualStop: "Sync asks the recording service to stop",
  AcceptEnd: "you end the call",
  DispatchEndStop: "Sync asks the recording service to stop for the call end",
  FinalizeEnd: "Sync finishes ending the call",
  PublishCaptureStopped: "the recording service reports the capture stopped",
  ApplyCaptureStopped: "Sync marks the recording stopped",
  ApplyDeadlineStop: "the recording hits its time limit and Sync stops it",
  Claim: "a capture node picks up the job",
  NodeReady: "the node starts capturing",
  NodeAllocate: "the node starts a segment",
  NodeCommit: "the node saves a segment",
  NodeComplete: "the node finishes the capture",
  NodeFail: "the node fails",
  NodeRelinquish: "the node hands the job back",
  LeaseExpires: "the node goes quiet and its lease runs out",
  Recover: "the recovery sweep gives the job a new try or ends it",
  ExpireReservation: "nobody picked the job up in time",
  RenderStart: "rendering starts",
  RenderCommit: "the recording is saved",
  RenderFails: "rendering fails",
  ReservationEnds: "the recording's time slot ends",
  SalvageDeadlinePasses: "the salvage window closes",
  Done: null,
};

export const step = (action) => labels[action] ?? action;
