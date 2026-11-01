import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOffReason } from "./off-reason-criteria.mjs";

const off = { enabled: false, publication_id: null };
const observation = () => ({
  candidate: { welcome: { media_off_reason: true }, negotiated: true, stopped: { ...off, off_reason: "host", off_revision: 7 }, reopened: { ...off, off_reason: "host", off_revision: 7 } },
  baseline: { welcome: {}, live: true, unexpectedCloses: 0, reopenedUnexpectedCloses: 0, stopped: { ...off }, reopened: { ...off } },
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
    candidate.stopped = { ...off };
    candidate.reopened = { ...off };
  });
  assert.deepEqual(names, ["candidateWelcomeOffersExtension", "candidateSeesHostStop", "candidateReopenKeepsHostStop"]);
});

test("the baseline fails on a leaked field or a rejected frame", () => {
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.welcome = { media_off_reason: true };
    }),
    ["baselineWelcomeUnchanged"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.unexpectedCloses = 1;
    }),
    ["baselineWelcomeUnchanged"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.stopped = { ...off, off_reason: "host", off_revision: 7 };
    }),
    ["baselineSeesStopWithoutReason"],
  );
  assert.deepEqual(
    failing(({ baseline }) => {
      baseline.reopened = { ...off, off_revision: 7 };
    }),
    ["baselineReopenStaysOffWithoutReason"],
  );
});

test("the candidate needs the host stop revision to survive the reopen", () => {
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.reopened = { ...off, off_reason: "host", off_revision: 8 };
    }),
    ["candidateReopenKeepsHostStop"],
  );
  assert.deepEqual(
    failing(({ candidate }) => {
      candidate.stopped = { enabled: false, publication_id: null, off_reason: "self" };
    }),
    ["candidateSeesHostStop", "candidateReopenKeepsHostStop"],
  );
});

test("a missing observation fails instead of throwing", () => {
  assert.equal(evaluateOffReason({ candidate: {}, baseline: {} }).passed, false);
});
