import { V3SyncClient, InMemoryV3PendingTargetStore, computeV3StateDigest, encodeV3ClientFrame } from "../src/index.ts";

const seed = Number(process.argv[2] ?? 730_044);
const ids = {
  participant: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
  recovery: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
  projection: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24",
  event: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25",
};
const commandIds = ["wire-sdk-cmd-001", "wire-sdk-cmd-002", "wire-sdk-cmd-003", "wire-sdk-cmd-004", "wire-sdk-cmd-005", "wire-sdk-cmd-006"];
const forbiddenClientShapes = [
  { label: "raise_hand", frame: { type: "command", command_id: "wire-sdk-legacy-001", name: "raise_hand", payload: {} } },
  { label: "lower_hand", frame: { type: "command", command_id: "wire-sdk-legacy-002", name: "lower_hand", payload: {} } },
  { label: "open_admission", frame: { type: "command", command_id: "wire-sdk-legacy-003", name: "open_admission", payload: {} } },
  { label: "promote_participant", frame: { type: "command", command_id: "wire-sdk-legacy-004", name: "promote_participant", payload: { participant_session_id: ids.participant } } },
  { label: "demote_participant", frame: { type: "command", command_id: "wire-sdk-legacy-005", name: "demote_participant", payload: { participant_session_id: ids.participant } } },
  { label: "remote_force_on", frame: { type: "live_target", operation_id: "wire-sdk-legacy-006", name: "set_microphone_enabled", enabled: true, participant_session_id: ids.participant } },
];

async function run() {
  const schedule = ["ack_before_event", "event_before_ack", "committed_duplicate_evidence", "satisfied_duplicate_evidence", "rejection_rebase", "projection_exact_next_duplicate", "projection_gap_recovery", "restart_persisted_pending_target"];
  const evidence = {};
  const observations = [];
  const forbidden = exerciseForbiddenClientShapes();
  evidence.forbidden_client_shapes = forbidden;
  observations.push({ name: "forbidden_client_shape_encoding", rejected_count: forbidden.rejected_count });
  const { client, socket, state } = await liveHarness();

  let current = state;
  const ackBeforeEvent = client.setHandRaised(true, { commandId: commandIds[0] }).catch((error) => {
    throw error;
  });
  await settle();
  const ackBefore = await nextState(current, { participants: current.participants.map((participant) => ({ ...participant, handRaised: true })) });
  const ackBeforeFrame = committedAck(commandIds[0], ackBefore, "original");
  socket.receive(ackBeforeFrame);
  await settle();
  const pendingAtAck = client.getSnapshot().pendingCommandCount;
  const ackBeforeEventFrame = event("hand_raised", commandIds[0], current, ackBefore, { participant_session_id: ids.participant });
  socket.receive(ackBeforeEventFrame);
  await settle();
  await ackBeforeEvent;
  current = ackBefore;
  evidence.ack_before_event = { ack_seen_before_event: pendingAtAck === 1, settled_after_event: client.getSnapshot().pendingCommandCount === 0 };
  observations.push({ name: "ack_before_event", pending_at_ack: pendingAtAck });

  const eventBeforeAck = client.setAdmissionPolicy("approval", { commandId: commandIds[1] });
  await settle();
  const eventBefore = await nextState(current, { admissionPolicy: "approval" });
  socket.receive(event("admission_policy_changed", commandIds[1], current, eventBefore, { policy: "approval" }));
  await settle();
  const pendingAtEvent = client.getSnapshot().pendingCommandCount;
  socket.receive(committedAck(commandIds[1], eventBefore, "original"));
  await settle();
  await eventBeforeAck;
  current = eventBefore;
  evidence.event_before_ack = { event_seen_before_ack: pendingAtEvent === 1, settled_after_ack: client.getSnapshot().pendingCommandCount === 0 };
  observations.push({ name: "event_before_ack", pending_at_event: pendingAtEvent });

  const committedDuplicate = client.setDisplayName("Committed", { commandId: commandIds[2] });
  await settle();
  const committed = await nextState(current, { participants: current.participants.map((participant) => ({ ...participant, displayName: "Committed" })) });
  const committedOriginal = committedAck(commandIds[2], committed, "original");
  socket.receive(committedOriginal);
  socket.receive(committedAck(commandIds[2], committed, "original"));
  await settle();
  const pendingAtDuplicate = client.getSnapshot().pendingCommandCount;
  socket.receive(event("participant_display_name_changed", commandIds[2], current, committed, { participant_session_id: ids.participant, display_name: "Committed" }));
  await settle();
  await committedDuplicate;
  current = committed;
  evidence.committed_duplicate_evidence = { duplicate_ack_retained: pendingAtDuplicate === 1, settled_from_event_head: client.getSnapshot().pendingCommandCount === 0 };
  observations.push({ name: "committed_duplicate_evidence", duplicate_ack_count: 2 });

  const satisfiedDuplicate = client.setHandRaised(false, { commandId: commandIds[3] });
  await settle();
  const satisfied = satisfiedAck(commandIds[3], current, "original");
  socket.receive(satisfied);
  socket.receive(satisfiedAck(commandIds[3], current, "duplicate"));
  await settle();
  await satisfiedDuplicate;
  evidence.satisfied_duplicate_evidence = { duplicate_ack_accepted: true, control_revision_unchanged: client.getSnapshot().control?.revision === current.revision };
  observations.push({ name: "satisfied_duplicate_evidence", duplicate_ack_count: 2 });

  const rejected = client.setDisplayName("Rejected", { commandId: commandIds[4] }).catch((error) => error);
  await settle();
  const rebased = await nextState(current, { admissionPolicy: "closed" });
  socket.receive(event("admission_policy_changed", "wire-sdk-event-005", current, rebased, { policy: "closed" }));
  await settle();
  socket.receive({ type: "ack", command_id: commandIds[4], delivery: "original", outcome: "rejected", reason: "capability_denied" });
  const rejection = await rejected;
  current = rebased;
  const rebasedSnapshot = client.getSnapshot();
  evidence.rejection_rebase = {
    rejected: rejection?.code === "rejected",
    control_advanced: rebasedSnapshot.control?.revision === current.revision,
    optimistic_matches_control: JSON.stringify(rebasedSnapshot.optimisticControl) === JSON.stringify(rebasedSnapshot.control),
    pending_removed: rebasedSnapshot.pendingCommandCount === 0,
  };
  observations.push({ name: "rejection_rebase", rejected: true, control_revision: rebasedSnapshot.control?.revision });

  const projectionEvent = {
    type: "projection_event",
    stream: "media",
    projection_id: ids.projection,
    sequence: 1,
    item: { participant_session_id: ids.participant, source: "camera", enabled: true, publication_id: "wire-sdk-camera" },
  };
  socket.receive(projectionEvent);
  await settle();
  const projectionAfterEvent = client.getSnapshot().media;
  socket.receive(projectionEvent);
  await settle();
  const projectionAfterDuplicate = client.getSnapshot().media;
  evidence.projection_exact_next_duplicate = {
    sequence_after_event: projectionAfterEvent?.sequence === 1,
    duplicate_kept_sequence: projectionAfterDuplicate?.sequence === 1,
    item_count: projectionAfterDuplicate?.items.length,
  };
  observations.push({ name: "projection_exact_next_duplicate", sequence: projectionAfterDuplicate?.sequence, duplicate_accepted: true });

  socket.receive({ ...projectionEvent, sequence: 3, item: { ...projectionEvent.item, enabled: false, publication_id: null } });
  await settle();
  evidence.projection_gap_recovery = { phase_after_gap: client.getSnapshot().connection.phase, socket_closed_for_recovery: socket.closeInfo?.code === 1002 };
  observations.push({ name: "projection_gap_recovery", phase: client.getSnapshot().connection.phase });
  client.stop();

  evidence.restart_persisted_pending_target = await restartPendingTarget();
  observations.push({ name: "restart_persisted_pending_target", replayed_frame_count: evidence.restart_persisted_pending_target.replayed_frame_count });

  const invariants = {
    ack_and_event_ordering_is_explicit: evidence.ack_before_event.settled_after_event && evidence.event_before_ack.settled_after_ack,
    duplicate_ack_evidence_is_bounded: evidence.committed_duplicate_evidence.duplicate_ack_retained && evidence.satisfied_duplicate_evidence.duplicate_ack_accepted,
    rejection_rebases_optimistic_state: evidence.rejection_rebase.optimistic_matches_control && evidence.rejection_rebase.pending_removed,
    projections_require_exact_next_and_recover_on_gap: evidence.projection_exact_next_duplicate.duplicate_kept_sequence && evidence.projection_gap_recovery.phase_after_gap === "connecting",
    persisted_targets_replay_once_after_restart: evidence.restart_persisted_pending_target.replayed_frame_count === 1,
    forbidden_client_shapes_are_encoder_rejected: forbidden.all_encoder_rejected,
  };

  return {
    name: "sdk_v3_replica",
    seed,
    schedule,
    observations,
    evidence,
    bounds: { schedule_steps: schedule.length, max_observations: 32, max_pending_targets: 256, max_projection_evidence: 256 },
    invariants,
    verdict: Object.values(invariants).every(Boolean) ? "pass" : "fail",
  };
}

function exerciseForbiddenClientShapes() {
  const results = forbiddenClientShapes.map(({ label, frame }) => {
    let rejected = false;
    try {
      encodeV3ClientFrame(frame);
    } catch {
      rejected = true;
    }
    return { label, encoder_rejected: rejected };
  });
  return {
    labels: results.map(({ label }) => label),
    results,
    rejected_count: results.filter(({ encoder_rejected }) => encoder_rejected).length,
    all_encoder_rejected: results.every(({ encoder_rejected }) => encoder_rejected),
  };
}

async function liveHarness(options = {}) {
  const clock = deterministicClock(seed);
  const store = options.store ?? new InMemoryV3PendingTargetStore();
  const sockets = [];
  const factory = {
    connect: () => {
      const socket = new DeterministicSocket();
      sockets.push(socket);
      return socket;
    },
  };
  const client = new V3SyncClient({
    url: "ws://localhost/v3/sync",
    token: async () => "deterministic-token",
    webSocket: factory,
    pendingStore: store,
    clock,
    reconnectDelayMs: 60_000,
    retryDelayMs: 0,
    ids: { next: () => commandIds[5] },
    requestIds: { next: () => commandIds[5] },
  });
  await client.start();
  const socket = sockets.at(-1);
  if (!socket) throw new Error("v3 replica did not create a deterministic socket");
  socket.open();
  await settle();
  const state = await baseState();
  const snapshot = snapshotFor(state);
  socket.receive({ type: "welcome", protocol: 3, participant_session_id: ids.participant, participant_session_generation: 1, recovery_id: ids.recovery, head: head(state), mode: "snapshot", snapshot });
  await settle();
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: ids.projection, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: ids.projection, sequence: 0, items: [] });
  socket.receive({ type: "recovery_complete", recovery_id: ids.recovery, head: head(state) });
  await settle();
  if (client.getSnapshot().connection.phase !== "live") throw new Error(`v3 replica did not reach live after four-stream recovery (${client.getSnapshot().connection.phase})`);
  return { client, socket, state };
}

async function restartPendingTarget() {
  const store = new InMemoryV3PendingTargetStore();
  const first = await pendingHarness(store);
  const pending = first.client.setDisplayName("Persisted", { commandId: commandIds[5] }).catch(() => undefined);
  await settle();
  const staged = await store.load();
  first.client.stop();
  await pending;
  const resumed = await liveHarness({ store });
  const replayed = resumed.socket.sent.filter((frame) => frame.type === "command" && frame.name === "set_display_name");
  const pendingAfterRestart = resumed.client.getSnapshot().pendingCommandCount;
  resumed.client.stop();
  return { staged_count: staged.length, replayed_frame_count: replayed.length, pending_after_restart: pendingAfterRestart };
}

async function pendingHarness(store) {
  const sockets = [];
  const client = new V3SyncClient({
    url: "ws://localhost/v3/sync",
    token: async () => "deterministic-token",
    webSocket: {
      connect: () => {
        const socket = new DeterministicSocket();
        sockets.push(socket);
        return socket;
      },
    },
    pendingStore: store,
    clock: deterministicClock(seed),
    reconnectDelayMs: 60_000,
  });
  await client.start();
  return { client, socket: sockets[0] };
}

async function baseState() {
  const roleCapabilities = { host: ["subscribe"], cohost: ["subscribe"], participant: ["subscribe"] };
  const state = {
    revision: 1,
    stateSchemaVersion: 3,
    stateDigest: "",
    status: "active",
    admissionPolicy: "open",
    hostExitPolicy: "require_transfer",
    hostParticipantSessionId: ids.participant,
    deadlineAtMs: 900_000,
    deadlineGeneration: 1,
    roleCapabilities,
    recording: null,
    participants: [{ participantSessionId: ids.participant, displayName: "Host", handRaised: false, admissionRevision: 1, role: "host", eligibleRoles: ["host", "cohost"], capabilities: ["subscribe"] }],
    admissionRequests: [],
  };
  return { ...state, stateDigest: await computeV3StateDigest(state) };
}

async function nextState(state, patch) {
  const next = { ...state, ...patch, revision: state.revision + 1, stateDigest: "" };
  return { ...next, stateDigest: await computeV3StateDigest(next) };
}

function snapshotFor(state) {
  return {
    control_revision: state.revision,
    state_schema_version: state.stateSchemaVersion,
    state_digest: state.stateDigest,
    status: state.status,
    admission_policy: state.admissionPolicy,
    host_exit_policy: state.hostExitPolicy,
    host_participant_session_id: state.hostParticipantSessionId,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    role_capabilities: state.roleCapabilities,
    recording: null,
    participants: state.participants.map((participant) => ({
      participant_session_id: participant.participantSessionId,
      display_name: participant.displayName,
      hand_raised: participant.handRaised,
      admission_revision: participant.admissionRevision,
      role: participant.role,
      eligible_roles: participant.eligibleRoles,
      capabilities: participant.capabilities,
    })),
    admission_requests: [],
  };
}

function head(state) {
  return { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest };
}

function event(name, commandId, previous, next, payload) {
  return { type: "event", stream: "control", name, event_id: ids.event, base_revision: previous.revision, revision: next.revision, schema_version: next.stateSchemaVersion, resulting_state_digest: next.stateDigest, payload, command_id: commandId };
}

function committedAck(commandId, state, delivery) {
  return { type: "ack", command_id: commandId, delivery, outcome: "committed", event_id: ids.event, revision: state.revision, state_digest: state.stateDigest };
}

function satisfiedAck(commandId, state, delivery) {
  return { type: "ack", command_id: commandId, delivery, outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest };
}

function deterministicClock(now) {
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (callback, milliseconds) => {
      const handle = ++next;
      timers.set(handle, { callback, milliseconds });
      return handle;
    },
    clearTimeout: (handle) => timers.delete(handle),
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class DeterministicSocket {
  sent = [];
  closeInfo = null;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  open() {
    this.onopen?.();
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(code = 1000) {
    if (this.closeInfo) return;
    this.closeInfo = { code };
    this.onclose?.({ code });
  }
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
