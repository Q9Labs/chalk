import { resolve } from "node:path";

// Shared browser bootstrap for the real SDK's Sync-wire UI proofs.
export function syncFixtureEntry(participants, roleCapabilities) {
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "${resolve("sdks/typescript/client/src/space-client/space-client.ts")}";
import { computeV1StateDigest } from "${resolve("sdks/typescript/client/src/sync/v1-reducer.ts")}";
const participant = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const recovery = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const deadline = Date.now() + 300000;
const participants = ${JSON.stringify(participants)};
const roleCapabilities = ${JSON.stringify(roleCapabilities)};
const digest = await computeV1StateDigest({ revision: 1, stateSchemaVersion: 1, stateDigest: "0".repeat(64), status: "active", admissionPolicy: "open", deadlineAtMs: deadline, deadlineGeneration: 1, roleCapabilities, recording: null, participants, admissionRequests: [] });
const head = { revision: 1, state_schema_version: 1, state_digest: digest };
await fetch("/frames", { method: "POST", body: JSON.stringify([
  { type: "welcome", protocol: 1, participant_id: participant, participant_generation: 1, recovery_id: recovery, head, mode: "snapshot", entry_confirmation: true, entry_generation: 1, snapshot: { control_revision: 1, state_schema_version: 1, state_digest: digest, status: "active", admission_policy: "open", deadline_at_ms: deadline, deadline_generation: 1, role_capabilities: roleCapabilities, recording: null, participants: participants.map(({ participantId, displayName, handRaised, admissionRevision, role, capabilities }) => ({ participant_id: participantId, display_name: displayName, hand_raised: handRaised, admission_revision: admissionRevision, role, capabilities })), admission_requests: [] } },
  ...["media", "presence"].map(stream => ({ type: "projection_snapshot", stream, projection_id: recovery, sequence: 0, items: [] })),
  { type: "recovery_complete", recovery_id: recovery, head }
]) });
const token = audience => btoa('{"alg":"EdDSA"}') + "." + btoa(JSON.stringify({ aud: audience })) + ".fixture";
const expires = new Date(deadline).toISOString();
const diagnostics = [];
let dialCount = 0;
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args) { dialCount += 1; return Reflect.construct(target, args); }
});
const client = createSpaceClientForPlatform({ space: "fixture", baseUrl: location.origin, getAccess: async () => ({ subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: participant, participant_generation: 1 }, sync: { token: token("chalk-sync"), expires_at: expires }, media: { token: token("chalk-media"), expires_at: expires, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:127.0.0.1:9" } } }) }, { apiBaseUrl: location.origin, syncUrl: location.origin.replace("http", "ws") + "/v1/sync", whiteboardUrl: null, onConnectionDiagnostic: event => diagnostics.push(event) });
const root = createRoot(document.getElementById("root"));
`;
}

export function fixtureParticipant(displayName, role = "owner", participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21") {
  return { participantId, displayName, handRaised: false, admissionRevision: 1, role, eligibleRoles: [], capabilities: [] };
}
