import { expect, it } from "vitest";
import type { ChatUploadFile, SpaceClient } from "@q9labsai/chalk-client";
import { prepareChatAttachmentBatch } from "../composite/chat-upload-file";
import { presentableAccept, presentableFilesHint, presentableMimeTypes, presentFiles, presentingFileProblem, splitPresentingFiles } from "./presenting-files";

function file(name: string, type = "application/pdf", byteLength = 1024): ChatUploadFile {
  return new File([new Uint8Array(byteLength)], name, { type }) as ChatUploadFile;
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

it("returns a failed Stage file to the presenter instead of staging or sending it in chat", async () => {
  const { api, presented, sent } = client(false);
  const pdf = file("deck.pdf");
  const result = await presentFiles([pdf], api, { presentingAvailable: true, chatEnabled: true });
  expect(result.presented).toBeUndefined();
  expect(result.stageFailure).toEqual({ file: pdf, failure: { fileName: "deck.pdf", reason: "failed" } });
  expect(result.chatFiles).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(presented).toEqual(["attachment-deck.pdf"]);
  expect(sent).toEqual([]);
});

it("acknowledges the Stage file before uploading and passes upload progress through", async () => {
  const events: string[] = [];
  const api = {
    chat: {
      files: {
        upload: async (uploaded: ChatUploadFile, options?: { onProgress?: (fraction: number) => void }) => {
          events.push("upload");
          options?.onProgress?.(0.5);
          return { attachmentId: `attachment-${(uploaded as File).name}` };
        },
      },
    },
    presenting: { present: async () => ({ kind: "accepted", revision: 1 }) as const },
  } as unknown as SpaceClient;
  const result = await presentFiles([file("deck.pdf")], api, { onStageFile: (name) => events.push(`stage:${name}`), onProgress: (fraction) => events.push(`progress:${fraction}`) });
  expect(result.presented).toBe("deck.pdf");
  expect(events).toEqual(["stage:deck.pdf", "upload", "progress:0.5"]);
});

it("describes presentable files from the accepted types", () => {
  expect(presentableFilesHint()).toBe("PDF or image, up to 25 MB");
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

it("stages only five chat files and counts the rest", () => {
  const files = Array.from({ length: 6 }, (_, index) => file(`deck-${index}.pdf`));
  const split = splitPresentingFiles(files, { presentingAvailable: false, chatEnabled: true });
  expect(split.chatFiles).toEqual(files.slice(0, 5));
  expect(split.chatOverflow).toBe(1);
});

it("keeps the failed Stage file out of the composer batch and stages the rest", async () => {
  const files = Array.from({ length: 6 }, (_, index) => file("deck-" + index + ".pdf"));
  const { api } = client(false);
  const result = await presentFiles(files, api, { presentingAvailable: true, chatEnabled: true });
  expect(result.stageFailure?.failure).toEqual({ fileName: "deck-0.pdf", reason: "failed" });
  expect(result.chatFiles).toEqual(files.slice(1, 6));
  expect(result.chatOverflow).toBe(0);
});

it("skips empty files instead of blocking the valid chat batch", () => {
  const empty = file("empty.txt", "text/plain", 0);
  const valid = file("notes.txt", "text/plain");
  const split = splitPresentingFiles([empty, valid], { presentingAvailable: false, chatEnabled: true });
  expect(split.chatFiles).toEqual([valid]);
  expect(split.failures).toEqual([{ fileName: "empty.txt", reason: "empty" }]);
});

it("the composer skips empty files while accepting the valid rest", () => {
  const empty = file("empty.txt", "text/plain", 0);
  const valid = file("notes.txt", "text/plain");
  const batch = prepareChatAttachmentBatch([empty, valid], 0);
  expect(batch.accepted).toEqual([valid]);
  expect(batch.emptyCount).toBe(1);
  expect(batch.overflowCount).toBe(0);
  expect(batch.invalid).toBeUndefined();
});

it("the composer accepts files up to its remaining capacity", () => {
  const files = Array.from({ length: 4 }, (_, index) => file(`notes-${index}.txt`, "text/plain"));
  const batch = prepareChatAttachmentBatch(files, 3);
  expect(batch.accepted).toEqual(files.slice(0, 2));
  expect(batch.overflowCount).toBe(2);
});

it("the composer still rejects an unsupported file before staging the batch", () => {
  const batch = prepareChatAttachmentBatch([file("notes.txt", "text/plain"), file("archive.zip", "application/zip")], 0);
  expect(batch.invalid?.fileName).toBe("archive.zip");
});

it("keeps Office files in chat until the server accepts their formats", () => {
  const deck = file("deck.pptx", "");
  const split = splitPresentingFiles([deck], { presentingAvailable: true, chatEnabled: true });
  expect(split.stageFile).toBeUndefined();
  expect(presentingFileProblem(deck)).toBe("unsupported");
});

it("presents Office and Keynote files once their formats are accepted, even when the browser reports no type", () => {
  const deck = file("deck.pptx", "");
  const old = file("old.ppt", "application/octet-stream");
  const keynote = file("talk.key", "");
  const formats = ["pdf", "pptx", "ppt", "key"] as const;
  expect(splitPresentingFiles([deck], { formats }).stageFile).toBe(deck);
  expect(splitPresentingFiles([old], { formats }).stageFile).toBe(old);
  expect(splitPresentingFiles([keynote], { formats }).stageFile).toBe(keynote);
  expect(presentingFileProblem(keynote, formats)).toBeNull();
  expect(presentingFileProblem(keynote, ["pdf", "pptx"])).toBe("unsupported");
});

it("derives the picker's accept list and hint from the accepted formats", () => {
  expect(presentableMimeTypes().has("text/plain")).toBe(false);
  expect(presentableMimeTypes(["txt"]).has("text/plain")).toBe(true);
  expect(presentableAccept(["pdf", "docx"])).toBe("application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx");
  expect(presentableFilesHint(["pdf", "pptx", "docx", "xlsx"])).toBe("PDF, slides, documents or spreadsheets, up to 25 MB");
});
