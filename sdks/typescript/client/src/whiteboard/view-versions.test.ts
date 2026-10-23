import { expect, it } from "vitest";
import { ChalkWhiteboardViewVersions } from "./view-versions";

const owner = "10000000-0000-4000-8000-000000000001";
const person = "20000000-0000-4000-8000-000000000002";
const frames = [
  { name: "A1", ownerSequence: 1 },
  { name: "A2", ownerSequence: 3 },
  { name: "B1", ownerSequence: 2 },
].map((frame) => ({ ...frame, ownerId: owner, x: frame.ownerSequence, y: 0, width: 100, height: 100, bring: false }));

function permutations<T>(values: readonly T[]): T[][] {
  return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map((tail) => [value, ...tail]));
}

it.each(permutations(frames))("#451: one winner for arrival order %j", (...order) => {
  const versions = new ChalkWhiteboardViewVersions();
  let winner = "";
  for (const frame of order) {
    if (!versions.isNew(frame, person)) continue;
    versions.remember(frame, person);
    winner = frame.name;
  }
  expect(winner).toBe("A2");
});

it("drops connection-local watermarks when adopting an owner's snapshot", () => {
  const versions = new ChalkWhiteboardViewVersions();
  const first = frames[0];
  const latest = frames[1];
  if (!first || !latest) throw new Error("The triple must contain two tab-A moves");
  versions.remember(latest, person);
  versions.clear();
  expect(versions.isNew(first, person)).toBe(true);
});
