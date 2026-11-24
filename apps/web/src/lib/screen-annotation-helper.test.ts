import { afterEach, expect, test, vi } from "vitest";
import type { ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { createBrowserAnnotationHelper, type HelperPairAuthority } from "./screen-annotation-helper";
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
  const exchangeTypes: string[] = [];
  vi.stubGlobal("fetch", async (url: string, request?: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push(path);
    if (path === "/v1/exchange") exchangeTypes.push(JSON.parse(String(request?.body)).type);
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
  await expect(
    approval.attach(
      (status) => statuses.push(status),
      async () => "ABCD-EFGH-JKLM-NPQR",
    ),
  ).rejects.toThrow();
  expect(sent).toContain("/v1/cancel");
  expect(exchangeTypes).toEqual(["disconnect"]);
  expect(statuses).not.toContain("ready");
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
  const helperKey = await keyPair();
  let browserKey = "";
  let lastConfirmation = "";
  let replay = false;
  let cancelCount = 0;
  const authorizedTickets: string[] = [];
  vi.stubGlobal("window", { isSecureContext: true, location: { origin: pairOrigin } });
  const challenge = "A".repeat(43);
  let ticketCount = 0;
  const issueLocalTicket = async ({ share }: Parameters<HelperPairAuthority["issueLocalTicket"]>[0]) => ({
    pair: { ticket: `p.code.${share.layer.publication_id}`, expiresAtMs: expiry },
    attachment: { ticket: `a.t.${++ticketCount}`, expiresAtMs: expiry },
  });
  vi.stubGlobal("fetch", async (url: string, request?: RequestInit) => {
    const body = JSON.parse(String(request?.body));
    const route = new URL(url);
    switch (route.pathname) {
      case "/v1/challenge":
        if (browserKey !== "") return new Response(null, { status: 409 });
        browserKey = body.browserPublicKey;
        return Response.json({ version: 2, helperPublicKey: helperKey.publicKey, challenge, expiresAtMs: expiry });
      case "/v1/attach": {
        const transcript = ["chalk.helper.pair.v2", challenge, browserKey, helperKey.publicKey, await hash(body.pairTicket), body.attachmentHash].join("\n");
        const confirmation = replay ? lastConfirmation : await helperKey.sign(`chalk.helper.confirm.v2\n${transcript}\n${challenge}\n${expiry}\n${pairCode}`);
        lastConfirmation = confirmation;
        return Response.json({ sessionSecret: challenge, leaseExpiresAtMs: expiry, confirmation });
      }
      case "/v1/cancel": {
        expect(body.browserPublicKey).toBe(browserKey);
        const key = await crypto.subtle.importKey("raw", Uint8Array.from(Buffer.from(browserKey, "base64url")), "Ed25519", false, ["verify"]);
        const message = encoder.encode(`chalk.helper.cancel.v1\n${browserKey}`);
        expect(await crypto.subtle.verify("Ed25519", key, Uint8Array.from(Buffer.from(body.proof, "base64url")), message)).toBe(true);
        browserKey = "";
        cancelCount++;
        return new Response(null, { status: 204 });
      }
      case "/v1/exchange":
        if (body.type === "authorize") authorizedTickets.push(body.attachmentTicket);
        return new Response(null, { status: 503 });
      default:
        throw new Error("Unexpected Helper request");
    }
  });
  async function pair({ publication = "first", code = pairCode, cancel = false } = {}) {
    const layer = { layer_id: "layer", publication_id: publication, sharer_id: "sharer" };
    const share = {
      client: { getSnapshot: () => ({ status: "ready", state: { layer } }), subscribe: () => () => {} },
      layer,
      participantId: "sharer",
      surface: null,
    } as unknown as ScreenAnnotationHelperShare;
    const helper = createBrowserAnnotationHelper({
      origin: pairOrigin,
      authority: { issueLocalTicket },
    });
    const result = await helper.challenge(share, new AbortController().signal);
    if (result.kind !== "approval") throw new Error("Helper not available");
    let neededCode = false;
    const attached = result.attach(
      () => {},
      async () => {
        neededCode = true;
        if (cancel) throw new Error("Canceled.");
        return code;
      },
    );
    await expect(attached).rejects.toThrow(); // The fixture stops at authorize.
    return { neededCode, remembered: result.remembered };
  }
  return {
    pair,
    authorizedTickets,
    cancellations: () => cancelCount,
    replay: () => {
      replay = true;
    },
  };
}

test("each share pairing requires its own typed code", async () => {
  const helper = await pairingFixture();
  for (let i = 0; i < 2; i++) {
    expect(await helper.pair()).toEqual({ neededCode: true, remembered: false });
  }
  expect(helper.authorizedTickets).toEqual(["a.t.1", "a.t.2"]);
});

test.each([{ code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }, { cancel: true }])("can retry immediately after an unsuccessful code dialog: %j", async (failure) => {
  const helper = await pairingFixture();
  await helper.pair(failure);
  expect(helper.authorizedTickets).toEqual([]);
  expect(helper.cancellations()).toBe(1);
  await helper.pair();
  expect(helper.authorizedTickets).toEqual(["a.t.2"]);
});

test.each(["same share", "different share"] as const)("a signed approval cannot authorize another tab on the %s", async (scope) => {
  const helper = await pairingFixture();
  await helper.pair();
  helper.replay();
  await helper.pair({ publication: scope === "same share" ? "first" : "second" });
  expect(helper.authorizedTickets).toEqual(["a.t.1"]);
});

test("the same tab cannot reuse a signed approval for another share", async () => {
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
  const message = ["chalk.helper.confirm.v2", "chalk.helper.pair.v2", nonce, tab.browserPublicKey, publicKey, await hash(firstPair), await hash(attachment), nonce, expiry, pairCode].join("\n");
  const reply = {
    sessionSecret: nonce,
    leaseExpiresAtMs: expiry,
    confirmation: encode(await crypto.subtle.sign("Ed25519", helper.privateKey, bytes(message))),
  };
  await expect((await tab.bind(challenge, firstPair, attachment)).confirm(pairCode, reply)).resolves.toBeUndefined();
  await expect((await tab.bind(challenge, "p.a.second", attachment)).confirm(pairCode, reply)).rejects.toThrow("did not confirm this tab and share");
  await expect((await tab.bind(challenge, firstPair, "a.t.second")).confirm(pairCode, reply)).rejects.toThrow("did not confirm this tab and share");
});
