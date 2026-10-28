// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Avatar } from "../components/atomic/Avatar";
import { useCallLink } from "../components/call-limbo/useCallLink";
import { useMediaQuery } from "./useMediaQuery";
import { ReactionPicker } from "../components/composite/ReactionPicker";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("retries a changed avatar before committing a fallback, including returning to a failed URL", async () => {
  const committed: (string | null | undefined)[] = [];
  function View({ src, name = "Ada", generated = false }: { src: string; name?: string; generated?: boolean }) {
    useLayoutEffect(() => {
      committed.push(container.querySelector("img")?.getAttribute("src"));
    });
    return <Avatar src={src} name={name} generated={generated} />;
  }
  const render = (src: string, name?: string, generated?: boolean) => act(async () => root.render(<View src={src} name={name} generated={generated} />));
  const fail = () => act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
  await render("/a.png");
  await fail();
  expect(container.querySelector("img")).toBeNull();
  committed.length = 0;
  await render("/b.png");
  expect(committed).toEqual(["/b.png"]);
  await render("/a.png");
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/a.png");
  await fail();
  await render("/a.png", "Grace");
  expect(container.querySelector("img")).not.toBeNull();
  await fail();
  await render("/a.png", "Grace", true);
  expect(container.querySelector("img")).not.toBeNull();
});

it("closes the link before committing a participant arrival, but permits manual reopening", async () => {
  const committed: boolean[] = [];
  function View({ alone }: { alone: boolean }) {
    const link = useCallLink(alone);
    useLayoutEffect(() => {
      committed.push(link.open);
    });
    return <button onClick={link.toggle}>{String(link.open)}</button>;
  }
  const render = (alone: boolean) =>
    act(async () =>
      root.render(
        <StrictMode>
          <View alone={alone} />
        </StrictMode>,
      ),
    );
  await render(true);
  expect(container.textContent).toBe("true");
  committed.length = 0;
  await render(false);
  expect(committed).toEqual([false]);
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toBe("true");
  await render(false);
  expect(container.textContent).toBe("true");
  await render(true);
  await render(false);
  expect(container.textContent).toBe("false");
  await render(true);
  expect(container.textContent).toBe("false");
});

function mediaQueries() {
  const lists = new Map<string, MediaQueryList>();
  const values = new Map<string, boolean>();
  const matchMedia = vi.fn((query: string): MediaQueryList => {
    const existing = lists.get(query);
    if (existing) return existing;
    const list: MediaQueryList = Object.assign(new EventTarget(), {
      media: query,
      get matches() {
        return values.get(query) ?? false;
      },
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
    });
    lists.set(query, list);
    return list;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    list: matchMedia,
    change(query: string, value: boolean) {
      values.set(query, value);
      matchMedia(query).dispatchEvent(new Event("change"));
    },
  };
}
function Query({ query }: { query: string }) {
  return <span>{String(useMediaQuery(query))}</span>;
}

it("switches media-query subscriptions without committing the previous query and releases StrictMode listeners", async () => {
  const media = mediaQueries();
  media.change("wide", true);
  const wide = media.list("wide"),
    narrow = media.list("narrow");
  const addWide = vi.spyOn(wide, "addEventListener"),
    removeWide = vi.spyOn(wide, "removeEventListener");
  const addNarrow = vi.spyOn(narrow, "addEventListener"),
    removeNarrow = vi.spyOn(narrow, "removeEventListener");
  const committed: string[] = [];
  function View({ query }: { query: string }) {
    useLayoutEffect(() => {
      committed.push(container.textContent ?? "");
    });
    return <Query query={query} />;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <View query="wide" />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toBe("true");
  committed.length = 0;
  await act(async () =>
    root.render(
      <StrictMode>
        <View query="narrow" />
      </StrictMode>,
    ),
  );
  expect(committed).toEqual(["false"]);
  await act(async () => media.change("wide", false));
  expect(container.textContent).toBe("false");
  await act(async () => media.change("narrow", true));
  expect(container.textContent).toBe("true");
  await act(async () => root.unmount());
  expect(removeWide.mock.calls).toEqual(addWide.mock.calls);
  expect(removeNarrow.mock.calls).toEqual(addNarrow.mock.calls);
  root = createRoot(container);
});

it("hydrates a server media-query fallback before reading the browser value", async () => {
  const media = mediaQueries();
  media.change("wide", true);
  await act(async () => root.unmount());
  container.innerHTML = renderToString(<Query query="wide" />);
  expect(container.textContent).toBe("false");
  const recoverable = vi.fn();
  await act(async () => {
    root = hydrateRoot(container, <Query query="wide" />, { onRecoverableError: recoverable });
  });
  expect(container.textContent).toBe("true");
  expect(recoverable).not.toHaveBeenCalled();
});

it("does not steal focus after the reaction picker closes or unmounts during entry", async () => {
  vi.useFakeTimers();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  const render = (isOpen: boolean) => act(async () => root.render(<ReactionPicker isOpen={isOpen} onClose={() => {}} onSelect={() => {}} />));
  await render(true);
  await act(async () => vi.advanceTimersByTime(20));
  await render(false);
  await render(true);
  focus.mockClear();
  await act(async () => vi.advanceTimersByTime(30));
  expect(focus).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(20));
  expect(focus).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  root = createRoot(container);
});

it("resets request errors and expiry before committing a replacement request", async () => {
  const { useMediaRequestDialogState } = await import("../components/media-request-dialog/media-request-dialog-state");
  const committed: string[] = [];
  const deny = vi.fn(async () => {
    throw new Error("Denied");
  });
  function Request({ requestId, expiresAt }: { requestId: string; expiresAt: string }) {
    const state = useMediaRequestDialogState({ request: { requestId, expiresAt, kind: "unmute", actorParticipantId: "host", actorDisplayName: "Host" }, onAllow: deny, onDecline: () => {} });
    useLayoutEffect(() => {
      committed.push(`${state.isExpired}:${state.errorMessage ?? ""}`);
    });
    return <button onClick={() => state.runAction("allow")}>{state.isExpired ? "Expired" : (state.errorMessage ?? "Allow")}</button>;
  }
  await act(async () => root.render(<Request requestId="first" expiresAt={new Date(Date.now() + 60_000).toISOString()} />));
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).not.toBe("Allow");
  committed.length = 0;
  await act(async () => root.render(<Request requestId="second" expiresAt={new Date(Date.now() - 1).toISOString()} />));
  expect(committed).toEqual(["true:"]);
  expect(container.textContent).toBe("Expired");
});
