// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../test-support/preview-client";
import { useFilePresenting } from "./use-file-presenting";

afterEach(() => document.body.replaceChildren());

function mount(live: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createPreviewClient();
  let api: ReturnType<typeof useFilePresenting> | undefined;
  function Probe() {
    api = useFilePresenting({ client, notify: () => {}, live, chatOpen: false, chatEnabled: true, presentingAvailable: true, openChat: () => {} });
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
