import { expect, it } from "vitest";
import { matchParticipants, splitMatch } from "./participant-search";

it("splits a name around the first match, ignoring case", () => {
  expect(splitMatch("Amara Okafor", "MA")).toEqual(["A", "ma", "ra Okafor"]);
  expect(splitMatch("Amara Okafor", "  ra ")).toEqual(["Ama", "ra", " Okafor"]);
});

it("returns the whole name when nothing matches or the query is empty", () => {
  expect(splitMatch("Eli Cohen", "zz")).toEqual(["Eli Cohen", "", ""]);
  expect(splitMatch("Eli Cohen", " ")).toEqual(["Eli Cohen", "", ""]);
});

it("keeps the roster order of the people who match", () => {
  const people = ["Malik Haddad", "Eli Cohen", "Amara Okafor"].map((displayName) => ({ id: displayName, displayName }));
  expect(matchParticipants(people, "ma").map((person) => person.id)).toEqual(["Malik Haddad", "Amara Okafor"]);
});
