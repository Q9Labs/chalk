import { expect, it } from "vitest";
import type { ChatUploadFile, SpaceClient } from "@q9labsai/chalk-client";
import { presentFiles } from "./presenting-files";

function file(name: string, type = "application/pdf"): ChatUploadFile {
  return new File([new Uint8Array(1024)], name, { type }) as ChatUploadFile;
}

function client() {
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
        return { kind: "accepted", revision: 1 } as const;
      },
    },
  } as unknown as SpaceClient;
  return { api, presented, sent };
}

it("presents the first presentable file when Presenting is available", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: true, chatEnabled: true });
  expect(result).toMatchObject({ presented: "deck.pdf", chatted: 0, failures: [] });
  expect(presented).toEqual(["attachment-deck.pdf"]);
  expect(sent).toEqual([]);
});

it("sends a presentable file to chat when Presenting is unavailable", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: false, chatEnabled: true });
  expect(result).toMatchObject({ chatted: 1, failures: [] });
  expect(result.presented).toBeUndefined();
  expect(presented).toEqual([]);
  expect(sent).toEqual(["attachment-deck.pdf"]);
});

it("does not send hidden chat when both Presenting and chat are unavailable", async () => {
  const { api, presented, sent } = client();
  const result = await presentFiles([file("deck.pdf")], api, { presentingAvailable: false, chatEnabled: false });
  expect(result).toMatchObject({ chatted: 0, failures: [{ fileName: "deck.pdf", reason: "unsupported" }] });
  expect(presented).toEqual([]);
  expect(sent).toEqual([]);
});
