import { expect, it } from "vitest";
import type { ChatUploadFile, SpaceClient } from "@q9labsai/chalk-client";
import { presentFiles, splitPresentingFiles } from "./presenting-files";

function file(name: string, type = "application/pdf"): ChatUploadFile {
  return new File([new Uint8Array(1024)], name, { type }) as ChatUploadFile;
}

function client(presentAccepted = true) {
  const presented: string[] = [];
  const sent: string[] = [];
  const api = {
    chat: {
      files: {
        upload: async (uploaded: ChatUploadFile) => ({ attachmentId: `attachment-${uploaded.name}` }),
      },
      send: async (input: { attachments: readonly { attachmentId: string }[] }) => {
        sent.push(...input.attachments.map((attachment) => attachment.attachmentId));
      },
    },
    presenting: {
      present: async (attachmentId: string) => {
        presented.push(attachmentId);
        if (!presentAccepted) throw new Error("present failed");
        return { kind: "accepted", revision: 1 } as const;
      },
    },
  } as unknown as SpaceClient;
  return { api, presented, sent };
}

it("presents the first presentable file when Presenting is available", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: true, chatEnabled: true });
  expect(result).toMatchObject({ presented: "deck.pdf", chatFiles: [], failures: [] });
  expect(presented).toEqual(["attachment-deck.pdf"]);
  expect(sent).toEqual([]);
});

it("returns a presentable file for chat staging when Presenting is unavailable", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: false, chatEnabled: true });
  expect(result.failures).toEqual([]);
  expect(result.chatFiles).toHaveLength(1);
  expect(result.presented).toBeUndefined();
  expect(presented).toEqual([]);
  expect(sent).toEqual([]);
});

it("does not send hidden chat when both Presenting and chat are unavailable", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: false, chatEnabled: false });
  expect(result).toMatchObject({ chatFiles: [], failures: [{ fileName: "deck.pdf", reason: "unsupported" }] });
  expect(presented).toEqual([]);
  expect(sent).toEqual([]);
});

it("returns a failed Stage file for composer staging instead of sending it", async () => {
  const { api, presented, sent } = client(false);
  const pdf = file("deck.pdf");
  const result = await presentFiles([pdf], api, { presentingAvailable: true, chatEnabled: true });
  expect(result.presented).toBeUndefined();
  expect(result.chatFiles).toEqual([pdf]);
  expect(result.failures).toEqual([{ fileName: "deck.pdf", reason: "failed" }]);
  expect(presented).toEqual(["attachment-deck.pdf"]);
  expect(sent).toEqual([]);
});

it("splits a multi-file drop into one stage candidate and the remaining chat files", () => {
  const pdf = file("deck.pdf");
  const image = file("image.png", "image/png");
  const text = file("notes.txt", "text/plain");
  const split = splitPresentingFiles([pdf, image, text], { presentingAvailable: true, chatEnabled: true });
  expect(split.stageFile).toBe(pdf);
  expect(split.chatFiles).toEqual([image, text]);
  expect(split.failures).toEqual([]);
});

it("puts every sendable file in the chat split when Presenting is unavailable", () => {
  const pdf = file("deck.pdf");
  const image = file("image.png", "image/png");
  const split = splitPresentingFiles([pdf, image], { presentingAvailable: false, chatEnabled: true });
  expect(split.stageFile).toBeUndefined();
  expect(split.chatFiles).toEqual([pdf, image]);
});
