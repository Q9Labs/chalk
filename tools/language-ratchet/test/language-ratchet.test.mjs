import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TERMS, compareCounts, countText, emptyCounts, exclusionReason, runRatchet, surfaceFor } from "../src/ratchet.mjs";

function countsForSurface(surface, text) {
  const counts = emptyCounts();
  counts[surface] = countText(text);
  return counts;
}

test("counts banned terms across prose and identifier boundaries", () => {
  const counts = countText("RoomSession roomId room_sessions Lobby waiting-room waiting_room waitingroom VideoConference videoconference");

  assert.equal(counts.room, 5);
  assert.equal(counts.session, 1);
  assert.equal(counts.waitingroom, 1);
  assert.equal(counts["waiting_room"], 1);
  assert.equal(counts["waiting-room"], 1);
  assert.equal(counts.conference, 1);
  assert.equal(counts.videoconference, 2);
  assert.equal(counts.meeting, 0);
  assert.equal(counts.lobby, 1);
  assert.deepEqual(Object.keys(counts), TERMS);
});

test("an added banned term fails the ratchet", () => {
  const baseline = countsForSurface("apps/web", "Space");
  const current = countsForSurface("apps/web", "Space roomId");

  const comparison = compareCounts(current, baseline);
  assert.deepEqual(comparison.increases, [{ surface: "apps/web", term: "room", baseline: 0, current: 1, delta: 1 }]);
  assert.deepEqual(comparison.decreases, []);
});

test("a removed banned term demands --update", () => {
  const baseline = countsForSurface("apps/sync", "Episode session");
  const current = countsForSurface("apps/sync", "Episode");

  const comparison = compareCounts(current, baseline);
  assert.deepEqual(comparison.increases, []);
  assert.deepEqual(comparison.decreases, [{ surface: "apps/sync", term: "session", baseline: 1, current: 0, delta: 1 }]);
});

test("tracked-file changes return failure for increases and decreases", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "language-ratchet-test-"));
  const baselinePath = path.join(repositoryRoot, "tools/language-ratchet/baseline.json");
  const fixturePath = path.join(repositoryRoot, "fixture.txt");
  const originalError = console.error;
  const errors = [];
  console.error = (...argumentsList) => errors.push(argumentsList.join(" "));

  try {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
    await writeFile(fixturePath, "Space\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repositoryRoot });
    await runRatchet({ repositoryRoot, baselinePath, update: true });

    await writeFile(fixturePath, "Space roomId\n");
    assert.equal(await runRatchet({ repositoryRoot, baselinePath }), 1);
    assert.match(errors.join("\n"), /root\/room: \+1/);
    errors.length = 0;

    await runRatchet({ repositoryRoot, baselinePath, update: true });
    await writeFile(fixturePath, "Space\n");
    assert.equal(await runRatchet({ repositoryRoot, baselinePath }), 1);
    assert.match(errors.join("\n"), /Run pnpm run language:ratchet:update/);

    await rm(fixturePath);
    assert.equal(await runRatchet({ repositoryRoot, baselinePath, update: true }), 0);
  } finally {
    console.error = originalError;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("maps requested surfaces and excludes migration metadata and generated output", () => {
  assert.equal(surfaceFor("apps/mobile/src/index.ts"), "apps/mobile");
  assert.equal(surfaceFor("apps/transcription-dispatcher/src/index.ts"), "root");
  assert.equal(surfaceFor("packages/ui/src/index.ts"), "packages");
  assert.equal(surfaceFor("README.md"), "root");
  assert.equal(exclusionReason("GLOSSARY.md"), "migration reference or checklist");
  assert.equal(exclusionReason("apps/api/db/migrations/20260701000000_legacy_resource.sql"), "immutable migration history");
  assert.equal(exclusionReason("apps/api/internal/adapters/cloudflare/sfu/adapter.go"), "provider vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/adapters/cloudflare/sfu/adapter_test.go"), "provider vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/httpapi/sfu_signaling_observation_test.go"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/client.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/cloudflare-sfu.test.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/rtk.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/transport.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/types.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/react-native/src/space-client/cloudflare-rtk-native.ts"), "provider vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/adapters/postgres/sqlc/models.go"), "generated or vendored directory");
  assert.equal(exclusionReason("sdks/typescript/client/src/generated/http-api.ts"), "generated file or directory");
  assert.equal(exclusionReason("pnpm-lock.yaml"), "lockfile or dependency checksum");
  assert.equal(exclusionReason("tools/language-ratchet/src/ratchet.mjs"), null);
});
