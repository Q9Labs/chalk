import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const contractDirectory = `${root}/contract/webhooks/v1`;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const envelopeKeys = ["id", "event", "api_version", "occurred_at", "tenant_id", "data"];

const isCanonicalTimestamp = (value) => {
  if (!timestampPattern.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const readJSON = async (name) => JSON.parse(await readFile(`${contractDirectory}/${name}`, "utf8"));

const [schema, fixturesDocument, signatureVectors, journeyEvents] = await Promise.all([readJSON("event.schema.json"), readJSON("fixtures.json"), readJSON("signature-vectors.json"), readJSON("journey-events.json")]);

const fail = (message) => {
  throw new Error(`webhook v1 contract: ${message}`);
};

const objectEntries = (value) => (value !== null && typeof value === "object" ? Object.entries(value) : []);

const eventConstant = (value) => (Array.isArray(value) ? undefined : value?.event?.const);

const collectEventConstants = (value, constants = new Set()) => {
  const event = eventConstant(value);
  if (typeof event === "string") constants.add(event);
  for (const [, child] of objectEntries(value)) collectEventConstants(child, constants);
  return constants;
};

const isIdentifierKey = (key) => key === "id" || key.endsWith("_id");
const isUuidV4 = (value) => typeof value === "string" && uuidV4Pattern.test(value);

const validateIdentifier = (key, value, path) => {
  if (!isIdentifierKey(key)) return;
  if (value === null) return;
  if (!isUuidV4(value)) fail(`${path} must be a lowercase UUIDv4`);
};

const isTimestamp = (value) => typeof value === "string" && isCanonicalTimestamp(value);

const validateTimestamp = (key, value, path) => {
  if (!key.endsWith("_at")) return;
  if (value === null) return;
  if (!isTimestamp(value)) fail(`${path} must be UTC RFC 3339 with millisecond precision`);
};

const validateIdentifiersAndTimestamps = (value, path = "event") => {
  for (const [key, child] of objectEntries(value)) {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    validateIdentifier(key, child, childPath);
    validateTimestamp(key, child, childPath);
    validateIdentifiersAndTimestamps(child, childPath);
  }
};

const schemaEvents = collectEventConstants(schema);
const fixtures = fixturesDocument.fixtures;
if (fixturesDocument.api_version !== 1 || !Array.isArray(fixtures)) {
  fail("fixtures.json must declare api_version 1 and a fixtures array");
}

const fixtureEvents = new Set();
const fixtureIDs = new Set();
const fixtureBodies = new Map();
for (const fixture of fixtures) {
  if (typeof fixture.event !== "string" || typeof fixture.body_utf8 !== "string") {
    fail("every fixture needs event and body_utf8 strings");
  }
  const event = JSON.parse(fixture.body_utf8);
  if (JSON.stringify(event) !== fixture.body_utf8) {
    fail(`${fixture.event} is not compact canonical JSON`);
  }
  if (event.event !== fixture.event) fail(`${fixture.event} body has a mismatched event name`);
  if (event.api_version !== 1) fail(`${fixture.event} must use api_version 1`);
  if (Object.keys(event).join("\0") !== envelopeKeys.join("\0")) {
    fail(`${fixture.event} has a non-canonical envelope field order`);
  }
  if (fixtureEvents.has(event.event)) fail(`duplicate fixture for ${event.event}`);
  if (fixtureIDs.has(event.id)) fail(`duplicate Event ID ${event.id}`);
  validateIdentifiersAndTimestamps(event);
  const changedFields = event.data?.changed_fields;
  if (changedFields && changedFields.join("\0") !== [...changedFields].sort().join("\0")) {
    fail(`${fixture.event} changed_fields must be sorted`);
  }
  fixtureEvents.add(event.event);
  fixtureIDs.add(event.id);
  fixtureBodies.set(event.event, fixture.body_utf8);
}

const missingFixtures = [...schemaEvents].filter((event) => !fixtureEvents.has(event));
const unknownFixtures = [...fixtureEvents].filter((event) => !schemaEvents.has(event));
if (missingFixtures.length || unknownFixtures.length) {
  fail(`schema/fixture catalog drift; missing=${missingFixtures.join(",")} unknown=${unknownFixtures.join(",")}`);
}

const signedFixture = fixtureBodies.get("participant.joined");
if (signatureVectors.body_utf8 !== signedFixture) {
  fail("signature body must be the canonical participant.joined fixture");
}
const signedBody = JSON.parse(signatureVectors.body_utf8);
if (signatureVectors.webhook_id !== signedBody.id) fail("signature webhook_id must equal body id");
if (signedBody.data?.object?.name !== 'Ada – <&> "東京" \\') {
  fail("signature fixture must retain Unicode and hostile JSON escaping coverage");
}
const signatures = [];
for (const secret of signatureVectors.secrets ?? []) {
  if (!secret.value?.startsWith("whsec_") || !secret.signature?.startsWith("v1,")) {
    fail(`${secret.name ?? "unnamed"} signature vector has invalid prefixes`);
  }
  const key = Buffer.from(secret.value.slice("whsec_".length), "base64");
  if (key.byteLength !== 32) fail(`${secret.name} secret must decode to 32 bytes`);
  const message = `${signatureVectors.webhook_id}.${signatureVectors.webhook_timestamp}.${signatureVectors.body_utf8}`;
  const expected = `v1,${createHmac("sha256", key).update(message).digest("base64")}`;
  if (secret.signature !== expected) fail(`${secret.name} signature does not match`);
  signatures.push(expected);
}
if (signatures.length !== 2 || signatureVectors.overlap_header !== signatures.join(" ")) {
  fail("rotation overlap header must contain current and previous signatures");
}

if (journeyEvents.version !== 1 || new Set(journeyEvents.events).size !== journeyEvents.events.length) {
  fail("journey Event vocabulary must be version 1 and unique");
}
if (new Set(journeyEvents.terminal_states).size !== journeyEvents.terminal_states.length) {
  fail("journey terminal states must be unique");
}

console.log(`Webhook v1 contract valid: ${fixtures.length} Event fixtures, ${signatures.length} signatures, ${journeyEvents.events.length} journey Events.`);
