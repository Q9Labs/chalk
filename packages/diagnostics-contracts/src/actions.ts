import type { ActionCheckpointContract, ActionContractV1, DiagnosticActionStatus } from "./types.js";

type ActionGroupDefinition = Readonly<{
  group: string;
  root: string;
  owner: string;
  proofPrefix: string;
  actions: readonly string[];
}>;

const GROUPS: readonly ActionGroupDefinition[] = [
  { group: "Episode lifecycle", root: "episode", owner: "api", proofPrefix: "diag.v1.episode", actions: ["emerge", "start", "end.natural", "end.authorized", "end.linger", "end.deadline", "deadline.extend"] },
  { group: "Space access", root: "access", owner: "api + client SDK", proofPrefix: "diag.v1.access", actions: ["request", "approve", "deny", "refresh"] },
  { group: "Participant lifecycle", root: "participant", owner: "client SDK + Sync", proofPrefix: "diag.v1.participant", actions: ["join", "reconnect", "rejoin", "leave", "rename", "raised_hand.set"] },
  { group: "Microphone", root: "microphone", owner: "client SDK + SFU adapter", proofPrefix: "diag.v1.microphone", actions: ["publish", "unpublish", "recover"] },
  { group: "Camera", root: "camera", owner: "client SDK + SFU adapter", proofPrefix: "diag.v1.camera", actions: ["publish", "unpublish", "recover"] },
  { group: "Directed media", root: "media_request", owner: "client SDK + Sync", proofPrefix: "diag.v1.media_request", actions: ["request", "accept", "decline", "expire"] },
  { group: "Screen sharing", root: "screen", owner: "client SDK + SFU adapter", proofPrefix: "diag.v1.screen", actions: ["start", "stop", "unexpected_end", "recover"] },
  { group: "Sync", root: "sync", owner: "Sync + client SDK", proofPrefix: "diag.v1.sync", actions: ["connect", "authenticate", "snapshot", "live", "reconnect", "disconnect"] },
  { group: "Chat", root: "chat", owner: "client SDK + Sync", proofPrefix: "diag.v1.chat", actions: ["send", "retry", "page", "read", "attachment.prepare", "attachment.commit", "attachment.fail"] },
  { group: "Reactions", root: "reaction", owner: "client SDK + Sync", proofPrefix: "diag.v1.reaction", actions: ["send", "dedupe", "expire"] },
  { group: "Admission", root: "admission", owner: "API + Sync", proofPrefix: "diag.v1.admission", actions: ["policy.snapshot", "policy.change", "request", "admit", "deny"] },
  { group: "Roles and moderation", root: "moderation", owner: "API + Sync", proofPrefix: "diag.v1.moderation", actions: ["role.change", "capability.check", "microphone.disable", "camera.disable", "screen.disable", "remove", "ban"] },
  { group: "Recovery", root: "recovery", owner: "client SDK + API + Sync", proofPrefix: "diag.v1.recovery", actions: ["access.refresh", "media.retry", "sync.retry", "budget.exhaust"] },
  { group: "Recording", root: "recording", owner: "API + worker", proofPrefix: "diag.v1.recording", actions: ["start", "stop", "provider.callback", "finalize"] },
  { group: "Transcription", root: "transcription", owner: "API + worker", proofPrefix: "diag.v1.transcription", actions: ["start", "stop", "provider.callback", "finalize"] },
  { group: "Cleanup", root: "cleanup", owner: "API + worker", proofPrefix: "diag.v1.cleanup", actions: ["resource.release", "fan_in", "complete"] },
  { group: "Artifact", root: "artifact", owner: "API + worker", proofPrefix: "diag.v1.artifact", actions: ["reserve", "write", "commit", "fail"] },
  { group: "Webhook", root: "webhook", owner: "API + worker", proofPrefix: "diag.v1.webhook", actions: ["enqueue", "attempt", "retry", "deliver", "exhaust"] },
  { group: "Whiteboard", root: "whiteboard", owner: "whiteboard package + client SDK + Sync", proofPrefix: "diag.v1.whiteboard", actions: ["connect", "recover", "disconnect"] },
];

const CHECKPOINT_OVERRIDES: Readonly<Record<string, readonly ActionCheckpointContract[]>> = {
  "whiteboard.connect": [{ key: "transport_live", class: "required", displayOrder: 0 }],
  "whiteboard.recover": [
    { key: "recovery_started", class: "required", displayOrder: 0 },
    { key: "restored_cursor", class: "required", displayOrder: 1 },
  ],
  "whiteboard.disconnect": [{ key: "terminal", class: "required", displayOrder: 0 }],
  "chat.send": [
    { key: "intent", class: "required", displayOrder: 0 },
    { key: "validation", class: "required", displayOrder: 1 },
    { key: "authorization", class: "required", displayOrder: 2 },
    { key: "durable_commit", class: "required", displayOrder: 3 },
    { key: "sender_receipt", class: "required", displayOrder: 4 },
    { key: "paging_visibility", class: "required", displayOrder: 5 },
    { key: "recipient_projection", class: "conditional", displayOrder: 6, predicate: "recipient is connected and observable" },
  ],
  "chat.retry": [
    { key: "retry_link", class: "required", displayOrder: 0 },
    { key: "durable_commit", class: "required", displayOrder: 1 },
    { key: "sender_receipt", class: "required", displayOrder: 2 },
  ],
  "chat.page": [{ key: "page_visibility", class: "required", displayOrder: 0 }],
  "chat.read": [{ key: "read_commit", class: "required", displayOrder: 0 }],
  "chat.attachment.prepare": [
    { key: "validation", class: "required", displayOrder: 0 },
    { key: "storage_prepare", class: "required", displayOrder: 1 },
  ],
  "chat.attachment.commit": [
    { key: "storage_commit", class: "required", displayOrder: 0 },
    { key: "sender_receipt", class: "required", displayOrder: 1 },
  ],
  "chat.attachment.fail": [{ key: "failure", class: "required", displayOrder: 0 }],
  "reaction.send": [
    { key: "authorization", class: "required", displayOrder: 0 },
    { key: "accepted_commit", class: "required", displayOrder: 1 },
    { key: "sender_result", class: "required", displayOrder: 2 },
    { key: "recipient_projection", class: "conditional", displayOrder: 3, predicate: "recipient is connected and observable" },
  ],
  "reaction.dedupe": [{ key: "dedupe_key_outcome", class: "required", displayOrder: 0 }],
  "reaction.expire": [{ key: "server_expiry", class: "required", displayOrder: 0 }],
  "screen.start": [
    { key: "permission", class: "required", displayOrder: 0 },
    { key: "track_acquisition", class: "required", displayOrder: 1 },
    { key: "sync_commit", class: "required", displayOrder: 2 },
    { key: "sfu_publication", class: "required", displayOrder: 3 },
    { key: "remote_first_frame", class: "conditional", displayOrder: 4, predicate: "observable recipient exists" },
  ],
  "screen.stop": [{ key: "stop_confirmation", class: "required", displayOrder: 0 }],
  "screen.unexpected_end": [{ key: "track_end", class: "required", displayOrder: 0 }],
  "screen.recover": [{ key: "recovery_terminal", class: "required", displayOrder: 0 }],
  "moderation.role.change": [
    { key: "capability_decision", class: "required", displayOrder: 0 },
    { key: "command_commit", class: "required", displayOrder: 1 },
    { key: "target_application", class: "conditional", displayOrder: 2, predicate: "target is observable" },
  ],
  "moderation.capability.check": [{ key: "capability_decision", class: "required", displayOrder: 0 }],
  "moderation.remove": [
    { key: "capability_decision", class: "required", displayOrder: 0 },
    { key: "command_commit", class: "required", displayOrder: 1 },
    { key: "target_delivery", class: "required", displayOrder: 2 },
    { key: "target_application", class: "conditional", displayOrder: 3, predicate: "target is observable" },
  ],
  "moderation.ban": [
    { key: "capability_decision", class: "required", displayOrder: 0 },
    { key: "command_commit", class: "required", displayOrder: 1 },
    { key: "target_delivery", class: "required", displayOrder: 2 },
    { key: "target_application", class: "conditional", displayOrder: 3, predicate: "target is observable" },
  ],
};

const checkpoints = (...keys: readonly string[]): readonly ActionCheckpointContract[] => keys.map((key, displayOrder) => ({ key, class: "required", displayOrder }));

const accessCheckpoints = (operation: string): readonly ActionCheckpointContract[] => checkpoints("request", "auth_decision", operation === "access.deny" ? "safe_denial" : "bound_access_bundle");

const moderationCheckpoints = (): readonly ActionCheckpointContract[] => [...checkpoints("capability_decision", "command_commit", "target_delivery"), { key: "target_application", class: "conditional", displayOrder: 3, predicate: "target is observable" }];

type SemanticCheckpointRule = Readonly<{
  matches: (operation: string) => boolean;
  build: (operation: string) => readonly ActionCheckpointContract[];
}>;

const SEMANTIC_CHECKPOINT_RULES: readonly SemanticCheckpointRule[] = [
  { matches: (operation) => operation.startsWith("episode."), build: () => checkpoints("policy_snapshot", "authoritative_state", "terminal_reason") },
  { matches: (operation) => operation.startsWith("access."), build: accessCheckpoints },
  { matches: (operation) => operation.startsWith("participant."), build: () => checkpoints("membership_transition", "participant_result") },
  { matches: (operation) => operation.startsWith("microphone.") || operation.startsWith("camera."), build: () => checkpoints("intent", "local_track_state", "sync_commit", "sfu_publication") },
  { matches: (operation) => operation.startsWith("media_request."), build: () => checkpoints("capability_decision", "command_commit", "target_result") },
  { matches: (operation) => operation.startsWith("sync."), build: () => checkpoints("ordered_transition", "restored_cursor", "terminal") },
  { matches: (operation) => operation.startsWith("admission."), build: () => checkpoints("policy_decision", "authoritative_commit", "participant_result") },
  { matches: (operation) => operation.startsWith("moderation."), build: moderationCheckpoints },
  { matches: (operation) => operation.startsWith("recovery."), build: () => checkpoints("retry_link", "restored_state", "budget_terminal") },
  { matches: (operation) => operation.startsWith("recording.") || operation.startsWith("transcription."), build: () => checkpoints("authorized_branch", "attempt", "provider_result", "artifact_state") },
  { matches: (operation) => operation.startsWith("cleanup."), build: (value) => (value === "cleanup.fan_in" || value === "cleanup.complete" ? checkpoints("children_terminal", "fan_in_terminal") : checkpoints("resource_release", "child_terminal")) },
  { matches: (operation) => operation.startsWith("artifact."), build: () => checkpoints("pre_end_slot", "immutable_commit", "branch_terminal") },
  { matches: (operation) => operation.startsWith("webhook."), build: () => checkpoints("signed_attempt", "response_class", "terminal") },
];

const semanticCheckpoints = (operation: string): readonly ActionCheckpointContract[] => {
  const rule = SEMANTIC_CHECKPOINT_RULES.find(({ matches }) => matches(operation));
  return rule?.build(operation) ?? checkpoints("intent", "terminal");
};

const makeCheckpoints = (operation: string): readonly ActionCheckpointContract[] => CHECKPOINT_OVERRIDES[operation] ?? semanticCheckpoints(operation);

const makeAction = (group: ActionGroupDefinition, action: string): ActionContractV1 => {
  const operation = `${group.root}.${action}`;
  return {
    version: 1,
    group: group.group,
    root: group.root,
    action,
    operation,
    owner: group.owner,
    proofId: `${group.proofPrefix}.${action}`,
    expectationVersion: 1,
    checkpoints: makeCheckpoints(operation),
    expectationFixture: `expectation.${operation}.v1`,
    successFixture: `success.${operation}.v1`,
    failureFixture: `failure.${operation}.v1`,
  };
};

export const ACTION_SET_V1: readonly ActionContractV1[] = GROUPS.flatMap((group) => group.actions.map((action) => makeAction(group, action)));
export const ACTIONS_V1 = ACTION_SET_V1;
export const ACTION_SET = ACTION_SET_V1;
export const EPISODE_DIAGNOSTIC_ACTIONS_V1 = ACTION_SET_V1;
export const ACTION_OPERATION_KEYS: readonly string[] = ACTION_SET_V1.map((action) => action.operation);
export const ALLOWED_EVENT_ACTION_ROOTS: readonly string[] = [...ACTION_OPERATION_KEYS];

const ACTION_BY_OPERATION = new Map(ACTION_SET_V1.map((action) => [action.operation, action]));

export const getActionContract = (operation: string): ActionContractV1 | undefined => ACTION_BY_OPERATION.get(operation);
export const isSupportedAction = (operation: string): boolean => ACTION_BY_OPERATION.has(operation);

export const actionStatus = (operation: string): DiagnosticActionStatus => {
  const contract = getActionContract(operation);
  if (!contract) return "unclassified";
  return contract.unsupported ? "unsupported" : "supported";
};

export type ActionCoverageReport = Readonly<{
  complete: boolean;
  missing: readonly string[];
  malformed: readonly string[];
  unsupported: readonly string[];
}>;

export const validateActionCoverage = (actions: readonly ActionContractV1[] = ACTION_SET_V1): ActionCoverageReport => {
  const expected = new Set(ACTION_OPERATION_KEYS);
  const seen = new Set<string>();
  const malformed: string[] = [];
  const unsupported: string[] = [];
  for (const action of actions) {
    seen.add(action.operation);
    if (action.version !== 1 || action.checkpoints.length === 0 || !action.expectationFixture || !action.successFixture || !action.failureFixture || !action.proofId) malformed.push(action.operation);
    if (action.unsupported) unsupported.push(action.operation);
  }
  return {
    complete: expected.size === seen.size && [...expected].every((operation) => seen.has(operation)) && malformed.length === 0,
    missing: [...expected].filter((operation) => !seen.has(operation)),
    malformed,
    unsupported,
  };
};
