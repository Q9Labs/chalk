import { render, renderLogs, renderStatus } from "./view.js";

const state = {
  roomId: `lab-${crypto.randomUUID().slice(0, 8)}`,
  participants: [],
  room: { revision: 0, participants: new Map() },
  traces: [],
  frames: [],
  traceConnected: false,
  traceStartedAt: Date.now(),
  seenTraceKeys: new Set(),
  seenTraceOrder: [],
};

const names = ["Ada", "Bo", "Cora", "Dax", "Eli", "Fia"];
const labActor = { id: "lab", name: "Lab" };
const $ = (selector) => document.querySelector(selector);
const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

function addParticipant(name = names[state.participants.length] || `Guest ${state.participants.length + 1}`) {
  state.participants.push({
    id: `p${state.participants.length + 1}`,
    name,
    socket: null,
    status: "offline",
    cursor: null,
    commandNumber: 0,
    lastCommand: null,
  });
  render(state);
}

function tokenFor(participant) {
  const claims = JSON.stringify({
    tenant_id: "local-lab",
    room_id: state.roomId,
    participant_id: participant.id,
    display_name: participant.name,
    capabilities: ["raiseHand"],
  });
  const bytes = new TextEncoder().encode(claims);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function connect(participant, options = {}) {
  if (participant.socket) participant.socket.close();
  participant.status = "connecting";
  const socket = new WebSocket(`${wsBase}/v1/sync`);
  participant.socket = socket;
  render(state);

  socket.addEventListener("open", () => {
    const frame = { type: "hello", protocol: 1, token: options.token ?? tokenFor(participant) };
    if (Number.isInteger(options.cursor)) {
      frame.streams = { control: { cursor: options.cursor } };
    }
    sendFrame(participant, frame);
  });

  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    logFrame(participant, "inbound", frame);
    applyServerFrame(participant, frame);
  });

  socket.addEventListener("close", ({ code, reason }) => {
    if (participant.socket !== socket) return;
    participant.socket = null;
    participant.status = "offline";
    addClientStory(participant, `Connection closed (\`${code}\`${reason ? `: ${reason}` : ""}).`);
    render(state);
  });

  socket.addEventListener("error", () => addClientStory(participant, "The WebSocket reported an error."));
}

function disconnect(participant) {
  participant.socket?.close(1000, "closed from sync lab");
}

function sendFrame(participant, frame) {
  participant.socket.send(JSON.stringify(frame));
  logFrame(participant, "outbound", frame);
}

function sendHandCommand(participant) {
  const raised = state.room.participants.get(participant.id)?.hand_raised;
  const frame = {
    type: "command",
    command_id: `${participant.id}-${++participant.commandNumber}`,
    name: raised ? "lower_hand" : "raise_hand",
  };
  participant.lastCommand = frame;
  sendFrame(participant, frame);
}

function applyServerFrame(participant, frame) {
  serverFrameHandlers[frame.type]?.(participant, frame);
  render(state);
}

const serverFrameHandlers = {
  welcome(participant, frame) {
    participant.status = "live";
    if (frame.mode === "snapshot") applySnapshot(frame.snapshot);
    if (frame.mode === "replay") frame.events.forEach(applyEvent);
    participant.cursor = frame.mode === "snapshot" ? frame.snapshot.control_revision : frame.control_revision;
    addClientStory(participant, `Joined with a \`${frame.mode}\` at revision \`${participant.cursor}\`.`);
  },
  event(participant, frame) {
    applyEvent(frame);
    participant.cursor = frame.revision;
  },
  ack(participant, frame) {
    addClientStory(participant, `Command \`${frame.command_id}\` was \`${frame.result}\`.`);
  },
  error(participant, frame) {
    addClientStory(participant, `Protocol error: ${frame.message}.`);
  },
};

function applySnapshot(snapshot) {
  state.room.revision = snapshot.control_revision;
  state.room.participants = new Map(snapshot.participants.map((person) => [person.participant_id, person]));
}

function applyEvent(event) {
  roomEventHandlers[event.name]?.(state.room.participants, event.payload);
  state.room.revision = event.revision;
}

const roomEventHandlers = {
  participant_joined(people, payload) {
    people.set(payload.participant_id, {
      participant_id: payload.participant_id,
      display_name: payload.display_name,
      hand_raised: false,
    });
  },
  participant_left(people, payload) {
    people.delete(payload.participant_id);
  },
  hand_raised(people, payload) {
    people.get(payload.participant_id).hand_raised = true;
  },
  hand_lowered(people, payload) {
    people.get(payload.participant_id).hand_raised = false;
  },
};

function logFrame(participant, direction, frame) {
  state.frames.unshift({ at: new Date(), participant: participant.name, direction, frame });
  state.frames = state.frames.slice(0, 250);
  renderLogs(state);
}

function addClientStory(participant, message) {
  state.traces.unshift({
    at: new Date(),
    source: "client",
    action: participant.name,
    message,
    details: { participant_id: participant.id },
  });
  renderLogs(state);
}

function connectTraceStream() {
  const socket = new WebSocket(`${wsBase}/dev/traces`);
  socket.addEventListener("open", () => {
    state.traceConnected = true;
    renderStatus(state);
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const events = message.type === "history" ? message.events : [message.event];
    events.filter(relevantTrace).forEach(addServerTrace);
    renderLogs(state);
  });
  socket.addEventListener("close", () => {
    state.traceConnected = false;
    renderStatus(state);
    setTimeout(connectTraceStream, 1500);
  });
}

function relevantTrace(event) {
  if (event.details.room_id) return event.details.room_id === state.roomId;
  return Date.parse(event.timestamp) >= state.traceStartedAt;
}

function addServerTrace(event) {
  const traceKey = `${event.timestamp}:${event.id}`;
  if (state.seenTraceKeys.has(traceKey)) return;
  state.seenTraceKeys.add(traceKey);
  state.seenTraceOrder.push(traceKey);

  if (state.seenTraceOrder.length > 500) {
    state.seenTraceKeys.delete(state.seenTraceOrder.shift());
  }

  state.traces.unshift({
    at: new Date(event.timestamp),
    source: event.source,
    action: event.action,
    message: describeTrace(event),
    details: event.details,
  });
  state.traces = state.traces.slice(0, 500);
}

function describeTrace(event) {
  const d = event.details;
  const descriptions = {
    "socket.connected": `Connection \`#${d.connection_id}\` opened.`,
    "socket.participant_joined": `\`${d.participant_id}\` authenticated and joined with a \`${d.welcome_mode}\`.`,
    "socket.event_sent": `Sent \`${d.event}\` at revision \`${d.revision}\` to connection \`#${d.connection_id}\`.`,
    "socket.disconnected": `Connection \`#${d.connection_id}\` closed.`,
    "room.writer_started": `The authoritative room writer started at revision \`${d.revision}\`.`,
    "room.subscriber_added": `\`${d.participant_id}\` subscribed; ${d.subscribers} connection(s) now listening.`,
    "room.event_committed": `Committed \`${d.event}\`; room advanced to revision \`${d.revision}\`.`,
    "room.writer_stopped": `The room writer stopped at revision \`${d.revision}\` because the room became empty.`,
    "room.restart_requested": "A development drill stopped the authoritative room writer.",
    "command.processed": `\`${d.participant_id}\` sent \`${d.command}\`; result was \`${d.result}\`.`,
    "auth.token_rejected": `Rejected the token on connection \`#${d.connection_id}\`.`,
    "protocol.frame_rejected": `Rejected a frame: ${d.reason}.`,
  };
  return descriptions[`${event.source}.${event.action}`] || `${event.source} ${event.action.replaceAll("_", " ")}.`;
}

function firstLiveParticipant() {
  return state.participants.find((participant) => participant.status === "live");
}

function runInvalidTokenDrill() {
  const socket = new WebSocket(`${wsBase}/v1/sync`);
  socket.addEventListener("open", () => {
    const frame = { type: "hello", protocol: 1, token: "invalid-production-token" };
    socket.send(JSON.stringify(frame));
    logFrame({ name: "Auth probe" }, "outbound", { ...frame, token: "<invalid token>" });
  });
  socket.addEventListener("close", ({ code, reason }) => {
    addClientStory(labActor, `Bad-token probe closed with \`${code}\`${reason ? `: ${reason}` : ""}.`);
  });
}

function runMalformedFrameDrill() {
  const participant = firstLiveParticipant();
  if (!participant) return addClientStory(labActor, "Connect a participant before sending a malformed frame.");
  participant.socket.send("{not json");
  logFrame(participant, "outbound", { malformed_text: "{not json" });
}

function runDuplicateCommandDrill() {
  const participant = state.participants.find((person) => person.status === "live" && person.lastCommand);
  if (!participant) return addClientStory(labActor, "Commit a hand command before repeating its command ID.");
  sendFrame(participant, participant.lastCommand);
}

function runFutureCursorDrill() {
  const participant = firstLiveParticipant();
  if (!participant) return addClientStory(labActor, "Connect a participant before testing cursor fallback.");
  const futureCursor = state.room.revision + 100;
  addClientStory(participant, `Reconnecting with future cursor \`${futureCursor}\`; the server should return a snapshot.`);
  disconnect(participant);
  setTimeout(() => connect(participant, { cursor: futureCursor }), 350);
}

async function runWriterRestartDrill() {
  if (!firstLiveParticipant()) return addClientStory(labActor, "Connect a participant before restarting the room writer.");
  try {
    const response = await fetch(`/dev/rooms/${encodeURIComponent(state.roomId)}/restart`, { method: "POST" });
    addClientStory(labActor, response.ok ? "Room writer restart requested; connected sockets should close with `1012`." : "Room writer restart failed.");
  } catch {
    addClientStory(labActor, "Room writer restart could not reach the development server.");
  }
}

const drills = {
  "invalid-token": runInvalidTokenDrill,
  "malformed-frame": runMalformedFrameDrill,
  "duplicate-command": runDuplicateCommandDrill,
  "future-cursor": runFutureCursorDrill,
  "restart-writer": runWriterRestartDrill,
};

function participantFrom(target) {
  const id = target.closest(".card")?.dataset.participantId;
  return state.participants.find((person) => person.id === id);
}

$("#participants").addEventListener("click", ({ target }) => {
  const participant = participantFrom(target);
  if (!participant) return;
  const action = participantActions.find(({ selector }) => target.matches(selector));
  action?.run(participant);
});

const participantActions = [
  { selector: ".hand-action", run: sendHandCommand },
  {
    selector: ".connection-action",
    run: (participant) => (participant.socket ? disconnect(participant) : connect(participant)),
  },
  {
    selector: ".reconnect-action",
    run(participant) {
      disconnect(participant);
      setTimeout(() => connect(participant, { cursor: participant.cursor }), 350);
    },
  },
];

document.querySelector(".drill-grid").addEventListener("click", ({ target }) => {
  const drill = drills[target.dataset.drill];
  if (drill) drill();
});

$("#connect-all").addEventListener("click", () => state.participants.filter((p) => !p.socket).forEach((p) => connect(p)));
$("#disconnect-all").addEventListener("click", () => state.participants.forEach(disconnect));
$("#add-participant").addEventListener("click", () => addParticipant());
$("#new-room").addEventListener("click", () => resetRoom(`lab-${crypto.randomUUID().slice(0, 8)}`));
$("#room-id").addEventListener("change", ({ target }) => resetRoom(target.value.trim() || state.roomId));

function resetRoom(roomId) {
  state.participants.forEach((participant) => {
    disconnect(participant);
    participant.socket = null;
    participant.status = "offline";
    participant.cursor = null;
  });
  state.roomId = roomId;
  state.room = { revision: 0, participants: new Map() };
  state.traces = [];
  state.frames = [];
  state.traceStartedAt = Date.now();
  render(state);
  renderLogs(state);
}
$("#clear-logs").addEventListener("click", () => {
  state.traces = [];
  state.frames = [];
  renderLogs(state);
});
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    const framesActive = tab.dataset.tab === "frames";
    $("#story-log").classList.toggle("hidden", framesActive);
    $("#frame-log").classList.toggle("hidden", !framesActive);
    $(".trace-scroll").classList.toggle("frames-active", framesActive);
  }),
);

connectTraceStream();
render(state);
