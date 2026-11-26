// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../test-support/preview-client";
import { useFilePresenting } from "./use-file-presenting";

afterEach(() => document.body.replaceChildren());

function mount(live: boolean, openChat: () => void = () => {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createPreviewClient();
  let api: ReturnType<typeof useFilePresenting> | undefined;
  function Probe() {
    api = useFilePresenting({ client, notify: () => {}, live, chatOpen: false, chatEnabled: true, presentingAvailable: true, openChat });
    return <input ref={api.presentInputRef} type="file" aria-hidden="true" />;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
  return { hook: () => api };
}

it("opens the file picker even while the connection is not live", async () => {
  const { hook } = mount(false);
  const input = document.querySelector("input[type=file]");
  expect(input).toBeTruthy();
  const clicks = vi.fn();
  input?.addEventListener("click", clicks);
  await act(async () => {
    await hook()?.choosePresentFiles();
  });
  expect(clicks).toHaveBeenCalledTimes(1);
});

it("opens the file picker when live", async () => {
  const { hook } = mount(true);
  const input = document.querySelector("input[type=file]");
  const clicks = vi.fn();
  input?.addEventListener("click", clicks);
  await act(async () => {
    await hook()?.choosePresentFiles();
  });
  expect(clicks).toHaveBeenCalledTimes(1);
});

it("stages every remaining dropped file in the chat composer instead of sending it", async () => {
  const openChat = vi.fn();
  const { hook } = mount(true, openChat);
  const pdf = new File([new Uint8Array(8)], "deck.pdf", { type: "application/pdf" });
  const image = new File([new Uint8Array(8)], "image.png", { type: "image/png" });
  const text = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf, image, text] } });

  await act(async () => {
    window.dispatchEvent(event);
  });

  expect(openChat).toHaveBeenCalledTimes(1);
  expect(hook()?.chatDrop?.files).toEqual([image, text]);
});
