import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOffReason } from "./off-reason-criteria.mjs";

const off = { enabled: false, publication_id: null };
const hostWire = { ...off, off_reason: "host", off_revision: 7 };
const hostDecoded = { enabled: false, publicationId: null, offReason: "host", offRevision: 7 };
const plainDecoded = { enabled: false, publicationId: null };
const sample = (wire, decoded) => ({ wire, decoded, live: true, unexpectedCloses: 0 });
const observation = () => ({
  candidate: { welcome: { media_off_reason: true }, negotiated: true, stopped: sample(hostWire, hostDecoded), reopened: sample(hostWire, hostDecoded) },
  baseline: { welcome: {}, stopped: sample({ ...off }, plainDecoded), reopened: sample({ ...off }, plainDecoded) },
});
const failing = (change) => {
  const value = observation();
  change(value);
  return Object.entries(evaluateOffReason(value).checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
};

test("passes when the candidate gets the extension and the baseline sees the old shape", () => {
  assert.equal(evaluateOffReason(observation()).passed, true);
});

test("a Sync without the change fails only the candidate checks", () => {
  const names = failing(({ candidate }) => {
    candidate.welcome = {};
    candidate.negotiated = false;
    candidate.stopped = sample({ ...off }, plainDecoded);
    candidate.reopened = sample({ ...off }, plainDecoded);
  });
  assert.deepEqual(names, ["candidateWelcomeOffersExtension", "candidateSeesHostStop", "candidateReopenKeepsHostStop", "candidateSdkKeepsHostStop"]);
});

test("the baseline fails on a leaked field, a decoded reason, or a rejected frame", () => {
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.welcome = { media_off_reason: true };
    }),
    ["baselineWelcomeUnchanged"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.stopped.unexpectedCloses = 1;
    }),
    ["baselineConnectionStaysOpen"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.stopped.wire = hostWire;
    }),
    ["baselineSeesStopWithoutReason"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.reopened.wire = { ...off, off_revision: 7 };
    }),
    ["baselineReopenStaysOffWithoutReason"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.reopened.decoded = { ...plainDecoded, offReason: "host" };
    }),
    ["baselineSdkStateHasNoReason"],
  );
});

test("the candidate needs the host stop revision to survive the reopen", () => {
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.reopened = sample({ ...off, off_reason: "host", off_revision: 8 }, { ...hostDecoded, offRevision: 8 });
    }),
    ["candidateReopenKeepsHostStop"],
  );
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.stopped = sample({ ...off, off_reason: "self" }, { ...plainDecoded, offReason: "self" });
    }),
    ["candidateSeesHostStop", "candidateReopenKeepsHostStop", "candidateSdkKeepsHostStop"],
  );
});

test("the candidate fails when the SDK state drops what the wire carried", () => {
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.stopped.decoded = { enabled: false, publicationId: null, offReason: "host" };
    }),
    ["candidateSdkKeepsHostStop"],
  );
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.reopened.decoded = plainDecoded;
    }),
    ["candidateSdkKeepsHostStop"],
  );
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.stopped.decoded = { ...hostDecoded, offRevision: 6 };
    }),
    ["candidateSdkKeepsHostStop"],
  );
});

test("the candidate fails on an unexpected close or a socket that is not live", () => {
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.stopped.unexpectedCloses = 1;
    }),
    ["candidateConnectionStaysOpen"],
  );
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.reopened.live = false;
    }),
    ["candidateConnectionStaysOpen"],
  );
});

test("a missing observation fails instead of throwing", () => {
  assert.equal(evaluateOffReason({ candidate: {}, baseline: {} }).passed, false);
});
