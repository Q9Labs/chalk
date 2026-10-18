import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptProof } from "./proofs.mjs";

test("transcript proof waits for the signed completion of its own Transcript", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "proof-transcript-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiver = { events: new Map([["other", { event: "transcript.completed", data: { object: { id: "other-transcript" } } }]]) };
  let documentRead;
  const reachedDocument = new Promise((resolve) => {
    documentRead = resolve;
  });
  const run = {
    directory,
    tenantPath: "/v1/tenants/test",
    recordingId: "recording",
    signal: new AbortController().signal,
    apiRequest: async (method, path) => {
      if (path.endsWith("/document")) {
        documentRead();
        return { cues: [{ text: "Purple lantern quiet river screen sharing transcription" }] };
      }
      if (method === "POST") return { transcript: { id: "own-transcript" } };
      if (path.endsWith("/recordings/recording")) return { transcription_preparation: { status: "ready" } };
      assert.ok(path.endsWith("/transcripts/own-transcript"));
      return { status: "complete" };
    },
  };
  let completed = false;
  const proof = transcriptProof(run, receiver).then((result) => {
    completed = true;
    return result;
  });
  await reachedDocument;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, false, "another Transcript's webhook must not pass the proof");
  receiver.events.set("own", { event: "transcript.completed", data: { object: { id: "own-transcript" } } });
  const result = await proof;
  assert.equal(result.transcriptId, "own-transcript");
  assert.ok(result.signedEvents.includes("transcript.completed"));
  const evidence = JSON.parse(await readFile(join(directory, "signed-webhooks.json"), "utf8"));
  assert.ok(evidence.some((event) => event.objectId === "own-transcript" && event.verified));
});
