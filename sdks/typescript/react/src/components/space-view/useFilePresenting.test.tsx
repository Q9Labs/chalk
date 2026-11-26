// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { createPreviewClient } from "../../test-support/preview-client";
import { ChatPanelSurface } from "../composite/ChatPanel";
import { useFilePresenting } from "./use-file-presenting";

afterEach(() => document.body.replaceChildren());

HTMLElement.prototype.scrollTo = () => {};

type Notify = Parameters<typeof useFilePresenting>[0]["notify"];

function mount(live: boolean, openChat: () => void = () => {}, notify: Notify = () => {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createPreviewClient();
  let api: ReturnType<typeof useFilePresenting> | undefined;
  function Probe() {
    api = useFilePresenting({ client, notify, live, chatOpen: false, chatEnabled: true, presentingAvailable: true, openChat });
    return <input ref={api.presentInputRef} type="file" aria-hidden="true" />;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
  return { client, hook: () => api };
}

it("opens the file picker even while the connection is not live", async () => {
  const { hook } = mount(false);
  const input = document.querySelector("input[type=file]");
  expect(input).toBeTruthy();
  let pickerOpens = 0;
  input?.addEventListener("click", () => {
    pickerOpens += 1;
  });
  await act(async () => {
    await hook()?.choosePresentFiles();
  });
  expect(pickerOpens).toBe(1);
});

it("opens the file picker when live", async () => {
  const { hook } = mount(true);
  const input = document.querySelector("input[type=file]");
  let pickerOpens = 0;
  input?.addEventListener("click", () => {
    pickerOpens += 1;
  });
  await act(async () => {
    await hook()?.choosePresentFiles();
  });
  expect(pickerOpens).toBe(1);
});

it("stages every remaining dropped file in the chat composer instead of sending it", async () => {
  let chatOpens = 0;
  const { client, hook } = mount(true, () => {
    chatOpens += 1;
  });
  vi.spyOn(client.presenting, "present").mockResolvedValue({ kind: "accepted", revision: 1 });
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const image = new File([new Uint8Array(8)], "image.png", { type: "image/png" });
  const text = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf, image, text] } });

  await act(async () => {
    window.dispatchEvent(event);
  });

  expect(chatOpens).toBe(1);
  expect(hook()?.chatDrop?.files).toEqual([image, text]);
});

it("stages the dropped PDF in the composer when presenting it fails", async () => {
  const openChat = vi.fn();
  const { hook } = mount(true, openChat);
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf] } });

  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(openChat).toHaveBeenCalled();
  expect(hook()?.chatDrop?.files).toEqual([pdf]);
});

it("clears a consumed composer drop without clearing a newer one", async () => {
  const { hook } = mount(true);
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf] } });

  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  const key = hook()?.chatDrop?.key;
  expect(key).toBeDefined();

  act(() => hook()?.consumeChatDrop((key ?? 0) + 1));
  expect(hook()?.chatDrop?.key).toBe(key);
  act(() => hook()?.consumeChatDrop(key ?? 0));
  expect(hook()?.chatDrop).toBeUndefined();
});

it("stages five files and notices the overflow and an empty file", async () => {
  const notices: string[] = [];
  const { hook } = mount(
    true,
    () => {},
    (toast) => {
      notices.push(toast.message);
    },
  );
  const empty = new File([], "empty.txt", { type: "text/plain" });
  const files = Array.from({ length: 6 }, (_, index) => new File([new Uint8Array(8)], `notes-${index}.txt`, { type: "text/plain" }));
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [empty, ...files] } });

  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(hook()?.chatDrop?.files).toHaveLength(5);
  expect(notices).toContain("empty.txt is empty and was skipped.");
  expect(notices).toContain("Only the first 5 files were staged in chat.");
});

it("consumes a dropped batch after staging it in the composer", () => {
  const file = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" }) as ChatUploadFile;
  let consumedKey = 0;
  const root = createRoot(document.body.appendChild(document.createElement("div")));

  act(() => {
    root.render(<ChatPanelSurface messages={[]} droppedFiles={{ key: 7, files: [file] }} onDroppedFilesConsumed={(key) => (consumedKey = key)} />);
  });

  expect(consumedKey).toBe(7);
  expect(document.body.textContent).toContain("notes.txt");
});
