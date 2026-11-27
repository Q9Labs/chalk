// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { presentingFormatIdsFor, type ChatUploadFile } from "@q9labsai/chalk-client";
import { createPreviewClient } from "../../test-support/preview-client";
import { ChatPanelSurface } from "../composite/ChatPanel";
import { useFilePresenting } from "./use-file-presenting";

afterEach(() => document.body.replaceChildren());

HTMLElement.prototype.scrollTo = () => {};

type Notify = Parameters<typeof useFilePresenting>[0]["notify"];

function mount(live: boolean, openChat: () => void = () => {}, notify: Notify = () => {}, presentingAvailable = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createPreviewClient();
  let api: ReturnType<typeof useFilePresenting> | undefined;
  function Probe() {
    api = useFilePresenting({ client, notify, live, chatOpen: false, chatEnabled: true, presentingAvailable, formats: presentingFormatIdsFor(), openChat });
    return <input ref={api.presentInputRef} type="file" aria-hidden="true" />;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
  return { client, hook: () => api };
}

it("keeps the dropped PDF on the Stage card when presenting it fails, and sends it to chat only on request", async () => {
  const opened: string[] = [];
  const { hook } = mount(true, () => opened.push("chat"));
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf] } });

  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(opened).toEqual([]);
  expect(hook()?.chatDrop).toBeUndefined();
  expect(hook()?.stageUpload).toMatchObject({ kind: "failed", fileName: "deck.pdf", reason: "failed" });

  act(() => hook()?.sendStageUploadToChat());
  expect(opened).toEqual(["chat"]);
  expect(hook()?.chatDrop?.files).toEqual([pdf]);
  expect(hook()?.stageUpload).toBeNull();
});

it("acknowledges a dropped file on the Stage at once", async () => {
  const { client, hook } = mount(true);
  vi.spyOn(client.chat.files, "upload").mockImplementation(() => new Promise(() => {}));
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf] } });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  expect(hook()?.stageUpload).toEqual({ kind: "uploading", fileName: "deck.pdf", progress: null });
});

it("answers a dropped file that can't be presented on the Stage instead of a silent toast", async () => {
  const { hook } = mount(true);
  const key = new File([new Uint8Array(8)], "clip.mov", { type: "video/quicktime" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [key] } });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  expect(hook()?.stageUpload).toMatchObject({ kind: "failed", fileName: "clip.mov", reason: "unsupported" });
});
