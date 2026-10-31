import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('measures unmute silence without charging intentional mute time, and requires packets plus audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chalk-audio-analysis-'));
  const sample = (t, packets, audioLevel) => ({ t, states: [{ listener: 1, tracks: [{ speaker: 0, track: 'tone', packets, audioLevel, readyState: 'live', muted: false }] }] });
  const run = {
    version: 'fixture', sdkRevision: 'fixture', completed: 'complete', sessionsPerParticipant: [1, 1, 1, 1], network: [], faults: [],
    actions: [{ t: 12, participant: 0, kind: 'mic', enabled: false }, { t: 18, participant: 0, kind: 'mic', enabled: true }],
    samples: [sample(0, 10, 1), sample(10, 20, 1), sample(12, 30, 1), sample(18, 30, 0), sample(19, 40, 0), sample(20, 40, 1), sample(21, 50, 1)],
  };
  try {
    await writeFile(join(directory, 'matrix.json'), JSON.stringify({ versions: [run] }));
    execFileSync(process.execPath, [join(import.meta.dirname, 'audio-mute-matrix-report.mjs'), directory]);
    const [summary] = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    const pair = summary.pairs.find(pair => pair.listener === 1 && pair.speaker === 0);
    assert.equal(pair.expectedSeconds, 5);
    assert.equal(pair.lostSeconds, 3);
    assert.equal(summary.unmutes.find(unmute => unmute.listener === 1).seconds, 3);
    assert.equal(summary.neverAudible, 2);
    assert.equal(summary.pendingUnmuteObservations, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});
