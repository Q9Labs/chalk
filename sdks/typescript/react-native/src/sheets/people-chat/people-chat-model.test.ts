import type { ChatMessage, Participant, PendingChatSend } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";
import { groupMessages, messageSummary, mimeTypeOf, stagingError } from "./chat-model";
import { nextHandOrder, peopleRows } from "./people-model";

function person(participantId: string, displayName: string, handRaised = false): Participant {
  return {
    participantId,
    displayName,
    role: "participant",
    eligibleRoles: [],
    capabilities: [],
    handRaised,
    media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
  } as const satisfies Participant;
}

function message(messageId: string, participantId: string, text: string): ChatMessage {
  return { messageId, clientMessageId: `c-${messageId}`, sequence: messageId, participantId, displayName: participantId, text, createdAt: "2026-10-18T10:00:00Z", attachments: [] };
}

const photo = { attachmentId: "a", fileName: "IMG_0412.jpg", mimeType: "image/jpeg", byteLength: 10 } as const;
const pdf = { attachmentId: "b", fileName: "Q4 plan.pdf", mimeType: "application/pdf", byteLength: 10 } as const;

describe("peopleRows", () => {
  const roster = [person("me", "Hasan"), person("n", "Nora", true), person("s", "Sam", true), person("k", "Kai")];

  it("puts the raised-hands queue in the order hands went up, above everyone, once two hands are up", () => {
    const rows = peopleRows({ roster, waiting: [], handOrder: ["s", "n"], query: "" });
    expect(rows.map((row) => row.key)).toEqual(["section.hands", "hand.s", "hand.n", "section.call", "person.me", "person.n", "person.s", "person.k"]);
    expect(rows.find((row) => row.key === "person.n")).toMatchObject({ handNumber: 2 });
  });

  it("numbers nothing and shows no queue for a single raised hand", () => {
    const rows = peopleRows({ roster: [person("me", "Hasan"), person("n", "Nora", true)], waiting: [], handOrder: ["n"], query: "" });
    expect(rows.map((row) => row.kind)).toEqual(["person", "person"]);
    expect(rows[1]).toMatchObject({ handNumber: null });
  });

  it("filters by name and says when no one matches", () => {
    expect(peopleRows({ roster, waiting: [], handOrder: ["s", "n"], query: "no" }).map((row) => row.key)).toEqual(["person.n"]);
    expect(peopleRows({ roster, waiting: [], handOrder: [], query: "zed" })).toEqual([{ kind: "none", key: "none", query: "zed" }]);
  });

  it("keeps the first-raised hand at the front as others raise and lower", () => {
    const first = nextHandOrder([], [person("n", "Nora", true)]);
    const second = nextHandOrder(first, [person("n", "Nora", true), person("s", "Sam", true)]);
    expect(second).toEqual(["n", "s"]);
    expect(nextHandOrder(second, [person("n", "Nora"), person("s", "Sam", true)])).toEqual(["s"]);
    expect(nextHandOrder(second, [person("n", "Nora", true), person("s", "Sam", true)])).toBe(second);
  });
});

describe("groupMessages", () => {
  const self = { participantId: "me", displayName: "Hasan" };

  it("groups consecutive messages from one person and marks yours", () => {
    const groups = groupMessages([message("1", "n", "Hi"), message("2", "n", "Ready?"), message("3", "me", "Yes")], [], self, new Set());
    expect(groups.map((group) => [group.participantId, group.mine, group.entries.length])).toEqual([
      ["n", false, 2],
      ["me", true, 1],
    ]);
  });

  it("adds your waiting sends after the confirmed messages and hides ones you retried", () => {
    const failed: PendingChatSend = { clientMessageId: "p1", text: "Lost", attachments: [], status: "failed", error: null };
    const sending: PendingChatSend = { clientMessageId: "p2", text: "Again", attachments: [], status: "sending", error: null };
    const groups = groupMessages([message("1", "me", "First")], [failed, sending], self, new Set(["p1"]));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries.map((entry) => [entry.text, entry.state])).toEqual([
      ["First", "sent"],
      ["Again", "sending"],
    ]);
  });
});

describe("chat files", () => {
  it("says what a message with only attachments sent", () => {
    expect(messageSummary("", [photo])).toBe("Sent a photo");
    expect(messageSummary("", [photo, photo])).toBe("Sent 2 photos");
    expect(messageSummary("", [photo, pdf])).toBe("Sent 2 files");
    expect(messageSummary("Look", [photo])).toBe("Look");
  });

  it("refuses unknown types, files over 25 MB and a sixth file", () => {
    expect(stagingError({ name: "Demo.mov", mimeType: "video/quicktime", size: 10 }, 0)).toBe("Can’t send .mov files");
    expect(stagingError({ name: "Site photos.pdf", mimeType: "application/pdf", size: 31 * 1024 * 1024 }, 0)).toBe("Over the 25 MB limit");
    expect(stagingError({ name: "Agenda.pdf", mimeType: "application/pdf", size: 10 }, 5)).toBe("Only 5 files per message");
    expect(stagingError({ name: "Agenda.pdf", mimeType: "application/pdf", size: 10 }, 4)).toBeNull();
  });

  it("falls back to the extension when the picker reports no type", () => {
    expect(mimeTypeOf("Budget 2027.XLSX", undefined)).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeTypeOf("notes", undefined)).toBe("application/octet-stream");
    expect(mimeTypeOf("a.png", "image/png")).toBe("image/png");
  });
});
