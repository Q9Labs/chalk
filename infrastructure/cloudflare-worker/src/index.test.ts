import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import worker from "./index";
import { generateSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signature";

const nowSeconds = Math.floor(new Date("2026-04-05T12:00:00Z").getTime() / 1000);

function makeEnv() {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({
        text: "hello world",
        word_count: 2,
        transcription_info: {
          language: "en",
          duration: 12.4,
        },
        segments: [{ start: 0, end: 1.2, text: "hello world" }],
      }),
    },
    TRANSCRIPTION_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    CLOUDFLARE_MODEL: "@cf/openai/whisper-large-v3-turbo",
    CHALK_TRANSCRIPTION_DISPATCH_SECRET: "dispatch-secret",
    CHALK_TRANSCRIPTION_CALLBACK_SECRET: "callback-secret",
  };
}

describe("cloudflare transcription worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts signed dispatch requests", async () => {
    const env = makeEnv();
    const payload = JSON.stringify({
      transcript_id: "11111111-1111-1111-1111-111111111111",
      recording_id: "22222222-2222-2222-2222-222222222222",
      room_id: "33333333-3333-3333-3333-333333333333",
      audio_url: "https://example.com/audio.webm",
      audio_storage_path: "recordings/audio.webm",
      callback_url: "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback",
    });

    const response = await worker.fetch(
      new Request("https://chalk-transcription.q9labs.ai/dispatch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: String(nowSeconds),
          [SIGNATURE_HEADER]: await generateSignature(env.CHALK_TRANSCRIPTION_DISPATCH_SECRET, nowSeconds, payload),
        },
        body: payload,
      }),
      env as any,
    );

    expect(response.status).toBe(202);
    expect(env.TRANSCRIPTION_QUEUE.send).toHaveBeenCalledTimes(1);
  });

  it("rejects unsigned dispatch requests", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://chalk-transcription.q9labs.ai/dispatch", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      env as any,
    );

    expect(response.status).toBe(401);
  });

  it("sends callback after queue completion", async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("audio", {
          status: 200,
          headers: { "content-type": "audio/webm" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        queue: "chalk-post-meeting-transcription",
        messages: [
          {
            id: "message-1",
            attempts: 1,
            body: {
              transcript_id: "11111111-1111-1111-1111-111111111111",
              recording_id: "22222222-2222-2222-2222-222222222222",
              room_id: "33333333-3333-3333-3333-333333333333",
              audio_url: "https://example.com/audio.webm",
              audio_storage_path: "recordings/audio.webm",
              callback_url: "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback",
              provider_job_id: "job-1",
            },
            ack,
            retry,
          },
        ],
      },
      env as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.AI.run).toHaveBeenCalledWith(
      env.CLOUDFLARE_MODEL,
      expect.objectContaining({
        audio: expect.objectContaining({
          contentType: "audio/webm",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("normalizes mp4 recordings to audio/mp4 before calling Workers AI", async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("video-bytes", {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        queue: "chalk-post-meeting-transcription",
        messages: [
          {
            id: "message-2",
            attempts: 1,
            body: {
              transcript_id: "11111111-1111-1111-1111-111111111111",
              recording_id: "22222222-2222-2222-2222-222222222222",
              room_id: "33333333-3333-3333-3333-333333333333",
              audio_url: "https://example.com/recording.mp4",
              audio_storage_path: "recordings/room/recording.mp4",
              callback_url: "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback",
              provider_job_id: "job-2",
            },
            ack,
            retry,
          },
        ],
      },
      env as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(env.AI.run).toHaveBeenCalledWith(
      env.CLOUDFLARE_MODEL,
      expect.objectContaining({
        audio: expect.objectContaining({
          contentType: "audio/mp4",
        }),
      }),
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
