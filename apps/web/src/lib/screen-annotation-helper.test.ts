import { afterEach, expect, test, vi } from "vitest";
import type { ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { createBrowserAnnotationHelper, type HelperPairAuthority } from "./screen-annotation-helper";
import { HelperConflict } from "./screen-annotation-helper-bridge";
import { calibrateWindow } from "./screen-annotation-helper-calibration";
import { startConsent } from "./screen-annotation-helper-consent";

afterEach(() => vi.unstubAllGlobals());

test("a loopback listener without native confirmation never receives a capture description", async () => {
  const origin = "https://chalk.example";
  const layer = { layer_id: "layer", publication_id: "publication", sharer_id: "sharer" };
  const share = {
    client: { getSnapshot: () => ({ status: "ready", state: { layer } }), subscribe: () => () => {} },
    layer,
    participantId: "sharer",
    surface: null,
  } as unknown as ScreenAnnotationHelperShare;
  vi.stubGlobal("window", { isSecureContext: true, location: { origin } });
  const expiry = Date.now() + 40_000;
  const key = "A".repeat(43);
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, request?: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push(path);
    if (path === "/v1/challenge") return Response.json({ version: 2, helperPublicKey: key, challenge: key, expiresAtMs: expiry });
    if (path === "/v1/attach") {
      expect(request?.body).not.toContain("a.t.t");
      return Response.json({ sessionSecret: key, leaseExpiresAtMs: expiry, confirmation: "A".repeat(86) });
    }
    return new Response(null, { status: 409 });
  });
  const helper = createBrowserAnnotationHelper({
    origin,
    authority: { issueLocalTicket: async () => ({ pair: { ticket: "p.a.r", expiresAtMs: expiry }, attachment: { ticket: "a.t.t", expiresAtMs: expiry } }) },
  });
  const approval = await helper.challenge?.(share, new AbortController().signal);
  expect(approval?.kind).toBe("approval");
  if (approval?.kind !== "approval") return;
  const statuses: string[] = [];
  await expect(approval.attach((status) => statuses.push(status), async () => "ABCD-EFGH-JKLM-NPQR")).rejects.toThrow();
  expect(sent).not.toContain("/v1/exchange");
  expect(statuses).not.toContain("ready");
});

function windowCalibration(captureTime?: (now: number) => number | undefined) {
  const controller = new AbortController();
  let callbacks = 0;
  const video = {
    style: {},
    videoWidth: 640,
    videoHeight: 360,
    setAttribute() {},
    remove() {},
    play: async () => {},
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => setTimeout(() => {
      callbacks++;
      if (callbacks > 5) {
        controller.abort();
        return;
      }
      const now = performance.now();
      callback(now, {
        captureTime: captureTime?.(now),
        presentationTime: now,
        expectedDisplayTime: now,
        presentedFrames: callbacks,
        mediaTime: callbacks / 60,
        width: 640,
        height: 360,
      });
    }, 5),
    cancelVideoFrameCallback: clearTimeout,
  };
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(72 * 72 * 4) }) };
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: (name: string) => (name === "video" ? video : { getContext: () => context }),
  });
  const track = { enabled: true, readyState: "live", clone: () => ({ enabled: true, stop() {} }) } as MediaStreamTrack;
  const point = { x: 0.5, y: 0.5, rgb: [255, 0, 255] as [number, number, number] };
  const probe = { nonce: "A".repeat(22), points: [point, point, point] as [typeof point, typeof point, typeof point] };
  return {
    track,
    signal: controller.signal,
    verify: async () => true,
    start: async () => probe,
    painted: vi.fn(async (_nonce: string, _signal: AbortSignal) => {
      expect(track.enabled).toBe(false);
    }),
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

test("window exclusion does not complete before the renderer acknowledges the probe", async () => {
  const options = windowCalibration(now => now);
  options.painted.mockRejectedValueOnce(new Error("no renderer acknowledgement"));
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
  expect(options.painted).toHaveBeenCalledWith("A".repeat(22), expect.any(AbortSignal));
});

test("delayed pre-paint frames cannot prove window exclusion after acknowledgement", async () => {
  let capturedBeforePaint = 0;
  const options = windowCalibration(() => capturedBeforePaint++);
  options.painted.mockImplementationOnce(async () => {
    capturedBeforePaint = performance.now() - 100;
    expect(options.track.enabled).toBe(false);
  });
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});

test("window exclusion fails closed without capture timestamps", async () => {
  const options = windowCalibration();
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});

test("window exclusion can complete with four distinct post-paint captures", async () => {
  const options = windowCalibration(now => now);
  await calibrateWindow(options);
  expect(options.complete).toHaveBeenCalledOnce();
  expect(options.abort).not.toHaveBeenCalled();
  expect(options.track.enabled).toBe(true);
});

test("a stale request to start a window probe does not tear down a ready overlay", async () => {
  const options = windowCalibration(now => now);
  await calibrateWindow({
    ...options,
    start: async () => {
      throw new HelperConflict("A probe is already ready.");
    },
  });
  expect(options.painted).not.toHaveBeenCalled();
  expect(options.abort).not.toHaveBeenCalled();
  expect(options.track.enabled).toBe(true);
});

test("an uncertain window probe start still clears the native probe before resuming the share", async () => {
  const options = windowCalibration(now => now);
  options.abort.mockImplementationOnce(async () => {
    expect(options.track.enabled).toBe(false);
  });
  await calibrateWindow({
    ...options,
    start: async () => { throw new Error("The response was lost."); },
  });
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});

const pairOrigin = "https://chalk.example";
const pairCode = "ABCDEFGHJKLMNPQR";

async function pairingFixture() {
  const expiry = Date.now() + 40_000;
  const encoder = new TextEncoder();
  const b64 = (value: ArrayBuffer) => Buffer.from(value).toString("base64url");
  const hash = async (token: string) => b64(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  async function keyPair() {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    return {
      publicKey: b64(await crypto.subtle.exportKey("raw", keys.publicKey)),
      sign: async (message: string) => b64(await crypto.subtle.sign("Ed25519", keys.privateKey, encoder.encode(message))),
    };
  }
  let helperKey = await keyPair();
  let browserKey = "";
  let ticketCount = 0;
  let revoked = false;
  let falseProof = false;
  let legacy = false;
  let lastConfirmation = "";
  let replay = false;
  const authorize = vi.fn();
  const rememberKey = vi.fn(async () => {});
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    isSecureContext: true,
    location: { origin: pairOrigin },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  const challenge = "A".repeat(43);
  const issueLocalTicket = vi.fn(async ({ remembered, share }: Parameters<HelperPairAuthority["issueLocalTicket"]>[0]) => ({
    pair: { ticket: `p.${remembered && !revoked ? "remember" : "code"}.${share.layer.publication_id}`, expiresAtMs: expiry },
    attachment: { ticket: `a.t.${++ticketCount}`, expiresAtMs: expiry },
    remembered: remembered && !revoked,
  }));
  vi.stubGlobal("fetch", async (url: string, request?: RequestInit) => {
    const body = JSON.parse(String(request?.body));
    const route = new URL(url);
    switch (route.pathname) {
      case "/v1/challenge":
        if (legacy && route.search) throw new TypeError("Failed to fetch");
        browserKey = body.browserPublicKey;
        const keyProof = falseProof ? "A".repeat(86) : await helperKey.sign(`chalk.helper.key.v1\n${pairOrigin}\n${browserKey}\n${challenge}\n${expiry}`);
        return Response.json({
          version: 2,
          helperPublicKey: helperKey.publicKey,
          challenge,
          expiresAtMs: expiry,
          ...(legacy ? {} : { keyProof }),
        });
      case "/v1/attach": {
        const transcript = ["chalk.helper.pair.v2", challenge, browserKey, helperKey.publicKey, await hash(body.pairTicket), body.attachmentHash].join("\n");
        const code = body.pairTicket.split(".")[1] === "remember" ? "" : pairCode;
        const confirmation = replay ? lastConfirmation : await helperKey.sign(`chalk.helper.confirm.v2\n${transcript}\n${challenge}\n${expiry}\n${code}`);
        lastConfirmation = confirmation;
        return Response.json({ sessionSecret: challenge, leaseExpiresAtMs: expiry, confirmation });
      }
      case "/v1/exchange":
        if (body.type === "authorize") authorize();
        return new Response(null, { status: 503 });
      default:
        throw new Error("Unexpected Helper request");
    }
  });
  async function pair(accountId = "alice", publication = "first") {
    const layer = { layer_id: "layer", publication_id: publication, sharer_id: "sharer" };
    const share = {
      client: { getSnapshot: () => ({ status: "ready", state: { layer } }), subscribe: () => () => {} },
      layer, participantId: "sharer", surface: null,
    } as unknown as ScreenAnnotationHelperShare;
    const helper = createBrowserAnnotationHelper({
      origin: pairOrigin, accountId, authority: { issueLocalTicket, rememberKey },
    });
    const result = await helper.challenge(share, new AbortController().signal);
    if (result.kind !== "approval") throw new Error("Helper not available");
    const enterCode = vi.fn(async () => pairCode);
    const attached = result.attach(() => {}, enterCode);
    await expect(attached).rejects.toThrow(); // The fixture stops at authorize.
    return { enterCode, remembered: result.remembered };
  }
  return {
    pair, authorize, rememberKey, issueLocalTicket, storage,
    replaceKey: async () => { helperKey = await keyPair(); },
    revoke: () => { revoked = true; },
    forgeKeyProof: () => { falseProof = true; },
    useLegacy: () => { legacy = true; },
    replay: () => { replay = true; },
  };
}

test("only the first pairing of a pinned Helper requires a code", async () => {
  const helper = await pairingFixture();
  expect((await helper.pair()).enterCode).toHaveBeenCalledOnce();
  expect(helper.rememberKey).toHaveBeenCalledOnce();
  const later = await helper.pair();
  expect(later.remembered).toBe(true);
  expect(later.enterCode).not.toHaveBeenCalled();
  expect(helper.authorize).toHaveBeenCalledTimes(2);
});

test.each(["changed key", "revoked device", "another account", "cleared pin", "forged key proof", "older Helper"] as const)("%s requires a new code", async (change) => {
  const helper = await pairingFixture();
  await helper.pair();
  if (change === "changed key") await helper.replaceKey();
  if (change === "revoked device") helper.revoke();
  if (change === "cleared pin") helper.storage.clear();
  if (change === "forged key proof") helper.forgeKeyProof();
  if (change === "older Helper") helper.useLegacy();
  const later = await helper.pair(change === "another account" ? "bob" : "alice");
  expect(later.remembered).toBe(false);
  expect(later.enterCode).toHaveBeenCalledOnce();
  expect(helper.authorize).toHaveBeenCalledTimes(2);
});

test.each(["same share", "different share"] as const)("a pinned response cannot authorize another tab on the %s", async (scope) => {
  const helper = await pairingFixture();
  await helper.pair();
  await helper.pair();
  helper.replay();
  const later = await helper.pair("alice", scope === "different share" ? "second" : "first");
  expect(later.remembered).toBe(true);
  expect(later.enterCode).not.toHaveBeenCalled();
  expect(helper.authorize).toHaveBeenCalledTimes(2);
});

test("the same tab cannot reuse remembered approval for another share", async () => {
  const tab = await startConsent();
  const helper = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const encode = (value: ArrayBuffer) => Buffer.from(value).toString("base64url");
  const bytes = (value: string) => new TextEncoder().encode(value);
  const hash = async (value: string) => encode(await crypto.subtle.digest("SHA-256", bytes(value)));
  const publicKey = encode(await crypto.subtle.exportKey("raw", helper.publicKey));
  const nonce = "A".repeat(43);
  const expiry = Date.now() + 40_000;
  const challenge = { version: 2, challenge: nonce, helperPublicKey: publicKey, expiresAtMs: expiry };
  const firstPair = "p.a.first";
  const attachment = "a.t.first";
  const message = ["chalk.helper.confirm.v2", "chalk.helper.pair.v2", nonce, tab.browserPublicKey, publicKey,
    await hash(firstPair), await hash(attachment), nonce, expiry, ""].join("\n");
  const reply = {
    sessionSecret: nonce, leaseExpiresAtMs: expiry,
    confirmation: encode(await crypto.subtle.sign("Ed25519", helper.privateKey, bytes(message))),
  };
  await expect((await tab.bind(challenge, firstPair, attachment, true)).confirm(null, reply)).resolves.toBeUndefined();
  await expect((await tab.bind(challenge, "p.a.second", attachment, true)).confirm(null, reply)).rejects.toThrow("did not confirm this tab and share");
  await expect((await tab.bind(challenge, firstPair, "a.t.second", true)).confirm(null, reply)).rejects.toThrow("did not confirm this tab and share");
});
