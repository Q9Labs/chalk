import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAndroidSignaling } from "./android-signaling-fetch";

function nativeRequest() {
  const sent = Promise.withResolvers<{ body: string; headers: Headers }>();
  class NativeRequest {
    status = 200;
    statusText = "OK";
    responseText = '{"session_description":{"type":"answer","sdp":"v=0"}}';
    onload?: () => void;
    onabort?: () => void;
    headers = new Headers();

    open = vi.fn();
    abort = vi.fn(() => this.onabort?.());
    getAllResponseHeaders = () => "Content-Type: application/json\r\n";
    setRequestHeader = (name: string, value: string) => this.headers.append(name, value);
    send = (body: string) => sent.resolve({ body, headers: this.headers });
  }
  const xhr = new NativeRequest();
  vi.stubGlobal("XMLHttpRequest", class { constructor() { return xhr; } });
  return { xhr, sent: sent.promise };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Android signaling during app capture", () => {
  it("delivers the SDP answer while foreground JS timers are paused", async () => {
    const { xhr, sent } = nativeRequest();
    vi.useFakeTimers();
    const body = '{"op":"tracks"}';
    const response = fetchAndroidSignaling("https://example.test/media/sfu/signal", {
      method: "POST",
      body,
      headers: { Authorization: "Bearer test" },
    });
    expect(await sent).toEqual({ body, headers: expect.any(Headers) });
    expect(xhr.headers.get("authorization")).toBe("Bearer test");
    xhr.onload?.();

    const reply = await response;
    expect(reply.headers.get("content-type")).toBe("application/json");
    expect(await reply.json()).toEqual({ session_description: { type: "answer", sdp: "v=0" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending native request without waiting for a timer", async () => {
    const { xhr, sent } = nativeRequest();
    vi.useFakeTimers();
    const controller = new AbortController();
    const response = fetchAndroidSignaling("https://example.test/media/sfu/signal", { method: "POST", body: "{}", signal: controller.signal });
    await sent;
    controller.abort();

    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.abort).toHaveBeenCalledOnce();
  });
});
