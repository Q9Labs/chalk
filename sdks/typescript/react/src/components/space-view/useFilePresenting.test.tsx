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

function mount(live: boolean, openChat: () => void = () => {}, notify: Notify = () => {}, presentingAvailable = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createPreviewClient();
  let api: ReturnType<typeof useFilePresenting> | undefined;
  function Probe() {
    api = useFilePresenting({ client, notify, live, chatOpen: false, chatEnabled: true, presentingAvailable, openChat });
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

  expect(opened).toEqual(["chat"]);
  expect(hook()?.chatDrop?.files).toEqual([pdf]);
});

it("updates a staged composer drop without clearing a newer one", async () => {
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

  act(() => hook()?.updateChatDrop((key ?? 0) + 1, []));
  expect(hook()?.chatDrop?.key).toBe(key);
  act(() => hook()?.updateChatDrop(key ?? 0, [pdf]));
  expect(hook()?.chatDrop?.files).toEqual([pdf]);
  act(() => hook()?.updateChatDrop(key ?? 0, []));
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
  expect(notices).toContain("Only the first 5 files were staged; 1 file could not be added.");
});

it("keeps a staged drop when chat unmounts and remounts until the user removes it", () => {
  const file = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" }) as ChatUploadFile;
  let batch: { readonly key: number; readonly files: readonly ChatUploadFile[] } | undefined = { key: 7, files: [file] };
  let reservations = 0;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (open: boolean) =>
    root.render(
      open ? (
        <ChatPanelSurface
          messages={[]}
          droppedFiles={batch}
          onDroppedFilesChange={(key, files) => {
            batch = files.length ? { key, files } : undefined;
          }}
          onUploadAttachment={async (file) => {
            reservations += 1;
            return { attachmentId: `a-${reservations}`, byteLength: file.size, fileName: file.name, mimeType: file.type };
          }}
        />
      ) : null,
    );

  act(() => render(true));
  expect(document.body.textContent).toContain("notes.txt");
  act(() => render(false));
  expect(document.body.textContent).not.toContain("notes.txt");
  act(() => render(true));
  expect(document.body.textContent).toContain("notes.txt");
  expect(reservations).toBe(0);

  const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Remove notes.txt");
  expect(remove).toBeDefined();
  act(() => remove?.click());
  expect(batch).toBeUndefined();
  act(() => root.unmount());
});

it("clears a staged drop when its message is sent", async () => {
  const file = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" }) as ChatUploadFile;
  let batch: { readonly key: number; readonly files: readonly ChatUploadFile[] } | undefined = { key: 8, files: [file] };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <ChatPanelSurface
        messages={[]}
        droppedFiles={batch}
        onDroppedFilesChange={(key, files) => {
          batch = files.length ? { key, files } : undefined;
        }}
        onUploadAttachment={async (file) => ({ attachmentId: "attachment-1", byteLength: file.size, fileName: file.name, mimeType: file.type })}
        onSendMessage={async () => {}}
      />,
    ),
  );
  const send = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Send message");
  expect(send).toBeDefined();
  await act(async () => {
    send?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(batch).toBeUndefined();
  act(() => root.unmount());
});

it("opens chat and stages five PDFs when Presenting is unavailable", async () => {
  const notices: string[] = [];
  let chatOpens = 0;
  const { hook } = mount(
    true,
    () => {
      chatOpens += 1;
    },
    (toast) => {
      notices.push(toast.message);
    },
    false,
  );
  const files = Array.from({ length: 6 }, (_, index) => new File([new Uint8Array(8)], `deck-${index}.pdf`, { type: "application/pdf" }));
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });

  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(chatOpens).toBe(1);
  expect(hook()?.chatDrop?.files).toEqual(files.slice(0, 5));
  expect(notices).toContain("Only the first 5 files were staged; 1 file could not be added.");
});

it("retains files from two drops when chat reopens", async () => {
  const { hook } = mount(
    true,
    () => {},
    () => {},
    false,
  );
  const one = new File([new Uint8Array(8)], "one.pdf", { type: "application/pdf" });
  const two = new File([new Uint8Array(8)], "two.pdf", { type: "application/pdf" });
  for (const file of [one, two]) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  expect(hook()?.chatDrop?.files).toEqual([one, two]);
});
