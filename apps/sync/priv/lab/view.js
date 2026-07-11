const $ = (selector) => document.querySelector(selector);

export function render(state) {
  $("#room-id").value = state.roomId;
  $("#revision").textContent = state.room.revision;
  $("#continuity").textContent = state.room.revision
    ? "Revision chain is continuous"
    : "Waiting for the first snapshot";
  const connected = state.participants.filter((person) => person.status === "live").length;
  $("#participant-count").textContent = `${connected} connected`;
  $("#empty-room").classList.toggle("hidden", state.participants.length > 0);
  renderParticipants(state);
  renderStatus(state);
}

function renderParticipants(state) {
  const container = $("#participants");
  container.replaceChildren();
  state.participants.forEach((participant) => {
    const card = $("#participant-template").content.firstElementChild.cloneNode(true);
    const roomParticipant = state.room.participants.get(participant.id);
    const handRaised = Boolean(roomParticipant?.hand_raised);
    card.dataset.participantId = participant.id;
    card.classList.toggle("hand-up", handRaised);
    card.querySelector(".avatar").textContent = participant.name.slice(0, 2).toUpperCase();
    card.querySelector(".identity strong").textContent = participant.name;
    card.querySelector(".identity span").textContent = `${participant.id} · ${participant.status}`;
    card.querySelector(".connection-dot").classList.toggle("live", participant.status === "live");
    card.querySelector(".participant-state strong").textContent = handRaised ? "Raised" : "Lowered";
    card.querySelector(".participant-state strong").classList.toggle("raised", handRaised);
    card.querySelector(".hand-action").textContent = handRaised ? "Lower hand" : "Raise hand";
    card.querySelector(".hand-action").disabled = participant.status !== "live";
    card.querySelector(".connection-action").textContent = participant.socket ? "Disconnect" : "Connect";
    card.querySelector(".reconnect-action").disabled = participant.status === "connecting";
    container.append(card);
  });
}

export function renderStatus(state) {
  $("#server-dot").classList.toggle("live", state.traceConnected);
  $("#server-status").textContent = state.traceConnected ? "Server trace live" : "Trace stream reconnecting";
}

export function renderLogs(state) {
  $("#story-log").replaceChildren(...state.traces.map(storyElement));
  $("#frame-log").replaceChildren(...state.frames.map(frameElement));
}

function storyElement(entry) {
  const element = document.createElement("article");
  element.className = `log-entry ${entry.source === "client" ? "client-entry" : ""}`;
  const meta = document.createElement("div");
  meta.className = "log-meta";
  const source = document.createElement("span");
  source.textContent = `${entry.source} · ${entry.action.replaceAll("_", " ")}`;
  const time = document.createElement("time");
  time.textContent = entry.at.toLocaleTimeString();
  meta.append(source, time);
  const message = document.createElement("p");
  message.textContent = entry.message;
  const details = document.createElement("code");
  details.textContent = JSON.stringify(entry.details);
  element.append(meta, message, details);
  return element;
}

function frameElement(entry) {
  const element = document.createElement("article");
  element.className = `raw-frame ${entry.direction}`;
  const header = document.createElement("header");
  const label = document.createElement("span");
  const arrow = entry.direction === "outbound" ? "CLIENT → SERVER" : "SERVER → CLIENT";
  label.textContent = `${arrow} · ${entry.participant}`;
  const time = document.createElement("time");
  time.textContent = entry.at.toLocaleTimeString();
  header.append(label, time);
  const payload = document.createElement("pre");
  payload.textContent = JSON.stringify(entry.frame, null, 2);
  element.append(header, payload);
  return element;
}
