// Statechart view for HostActsOnStudent.tla: what the host and the student
// see when the host removes the student or makes them an observer.

export const title = "A host removes or demotes a student";

export const state = (v) => {
  if (v.op === "none") return "Student is in the class";
  if (v.op === "remove") {
    return { working: "Removing the student", done: "Student removed", failed: "Could not remove, student is still in" }[v.hostSees];
  }
  return {
    working: "Making the student an observer, camera still on",
    done: "Student is an observer, camera stopped",
    failed: v.camera === "live" ? "Host told it failed, but the student is an observer with the camera on" : "Host told it failed, student is an observer",
  }[v.hostSees];
};

export const group = (v) => {
  if (v.hostSees === "idle") return "In the class";
  if (v.hostSees === "working") return "Working";
  return v.hostSees === "done" ? "Done" : "Failed";
};

export const colors = { "In the class": "teal", Working: "yellow", Done: "blue", Failed: "orange" };

const labels = {
  HostPressesRemove: "the host presses Remove",
  RemoveSucceeds: "the student is disconnected",
  RemoveGivesUp: "the removal fails after 100 tries",
  HostPressesDemote: "the host makes the student an observer",
  DemoteSucceeds: "the camera is stopped",
  DemoteFails: "stopping the camera fails",
  Done: null,
};

export const step = (action) => (action in labels ? labels[action] : action);
