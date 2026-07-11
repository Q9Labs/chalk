const $ = (selector) => document.querySelector(selector);
const avatarColors = ["#2f7a57", "#44659b", "#96631d", "#7b5ea7", "#b4514a", "#3b7e8c"];

export function render(state) {
  $("#room-id").value = state.roomId;
  $("#revision").textContent = state.room.revision;
  const connected = state.participants.filter((person) => person.status === "live").length;
  $("#participant-count").textContent = `${connected} of ${state.participants.length} connected`;
  $("#empty-room").classList.toggle("hidden", state.participants.length > 0);
  renderParticipants(state);
  renderStatus(state);
}

function renderParticipants(state) {
  const container = $("#participants");
  container.replaceChildren();
  state.participants.forEach((participant, index) => {
    const card = $("#participant-template").content.firstElementChild.cloneNode(true);
    const roomParticipant = state.room.participants.get(participant.id);
    const handRaised = Boolean(roomParticipant?.hand_raised);
    card.dataset.participantId = participant.id;
    card.classList.toggle("hand-up", handRaised);
    const avatar = card.querySelector(".avatar");
    avatar.textContent = participant.name.slice(0, 2).toUpperCase();
    avatar.style.background = avatarColors[index % avatarColors.length];
    card.querySelector(".identity strong").textContent = participant.name;
    card.querySelector(".identity code").textContent = participant.id;
    const badge = card.querySelector(".status-badge");
    badge.textContent = participant.status;
    badge.classList.toggle("live", participant.status === "live");
    badge.classList.toggle("connecting", participant.status === "connecting");
    card.querySelector(".hand-label").textContent = handRaised ? "Hand raised" : "Hand lowered";
    card.querySelector(".hand-action").textContent = handRaised ? "Lower hand" : "Raise hand";
    card.querySelector(".hand-action").disabled = participant.status !== "live";
    card.querySelector(".connection-action").textContent = participant.socket ? "Disconnect" : "Connect";
    const reconnect = card.querySelector(".reconnect-action");
    reconnect.textContent =
      participant.cursor === null ? "Reconnect & replay" : `Reconnect & replay from revision ${participant.cursor}`;
    reconnect.disabled = participant.cursor === null || participant.status === "connecting";
    container.append(card);
  });
}

export function renderStatus(state) {
  $("#server-dot").classList.toggle("live", state.traceConnected);
  $("#server-status").textContent = state.traceConnected ? "Server trace live" : "Trace stream reconnecting";
}

export function renderLogs(state) {
  $("#trace-hint").classList.toggle("hidden", state.traces.length > 0);
  $("#story-log").replaceChildren(...state.traces.map((entry) => (entry.el ??= storyElement(entry))));
  $("#frame-log").replaceChildren(...state.frames.map((entry) => (entry.el ??= frameElement(entry))));
}

function storyElement(entry) {
  const category = entry.source === "client" ? "client" : entry.source;
  const element = document.createElement("article");
  element.className = `trace-entry cat-${category}`;
  if (entry.source === "room" && entry.action === "event_committed") element.classList.add("commit");

  const rev = document.createElement("span");
  rev.className = "rev";
  rev.textContent = entry.details?.revision ?? "·";

  const body = document.createElement("div");
  body.className = "trace-body";
  const meta = document.createElement("div");
  meta.className = "trace-meta";
  const tag = document.createElement("span");
  tag.className = `tag cat-${category}`;
  tag.textContent = entry.source === "client" ? entry.action : entry.source;
  const time = document.createElement("time");
  time.textContent = entry.at.toLocaleTimeString();
  meta.append(tag, time);

  const message = document.createElement("p");
  message.append(...messageNodes(entry.message));
  body.append(meta, message);

  if (entry.details && Object.keys(entry.details).length > 0) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "payload";
    const code = document.createElement("code");
    code.textContent = JSON.stringify(entry.details, null, 2);
    details.append(summary, code);
    body.append(details);
  }

  element.append(rev, body);
  return element;
}

function messageNodes(message) {
  return message.split("`").map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    const code = document.createElement("code");
    code.textContent = part;
    return code;
  });
}

function frameElement(entry) {
  const element = document.createElement("article");
  element.className = `raw-frame ${entry.direction}`;
  const header = document.createElement("header");
  const dir = document.createElement("span");
  dir.className = "dir";
  dir.textContent = entry.direction === "outbound" ? "client → server" : "server → client";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = entry.participant;
  const time = document.createElement("time");
  time.textContent = entry.at.toLocaleTimeString();
  header.append(dir, who, time);
  const payload = document.createElement("pre");
  payload.textContent = JSON.stringify(entry.frame, null, 2);
  element.append(header, payload);
  return element;
}
