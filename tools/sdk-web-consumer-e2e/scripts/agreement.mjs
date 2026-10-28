import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { assertAgreement, installAgreementProbe, sampleAgreement, truthIssues } from "../../../scripts/web-proof/agreement.mjs";
import { recoveryBudgets } from "../../../scripts/web-proof/recovery-budgets.mjs";

const recoveryTimeoutMs = recoveryBudgets().timeoutMs;

export async function proveAgreementMatrix(browser, baseURL, { invoke, waitForState, device, fast = false }) {
  const failures = [];
  async function scenario(name, run) {
    const filter = process.env.CHALK_AGREEMENT_CASE;
    if (filter && !name.includes(filter)) return;
    const start = Date.now();
    const contexts = [];
    try {
      const open = async (participant) => {
        const context = await browser.newContext({ ...device, permissions: ["camera", "microphone"] });
        contexts.push(context);
        await context.addInitScript(installAgreementProbe);
        const page = await context.newPage();
        page.on("pageerror", (error) => process.stdout.write(`[agreement fixture ${participant}] ${error.message}\n`));
        await page.goto(`${baseURL}/?fixtureUser=${participant}`);
        await page.waitForFunction(() => Boolean(window.__chalk));
        await page.mouse.click(5, 5);
        // WebKit exposes host ICE candidates only after capture permission is
        // exercised. The SDK still uses our deterministic tone/canvas tracks.
        if (device)
          await page.evaluate(async () => {
            const capture = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            for (const track of capture.getTracks()) track.stop();
          });
        await invoke(page, "join");
        await waitForState(page, "live");
        return page;
      };
      const pages = [await open("agreementalice"), await open("agreementbob")];
      await assertAgreement(pages);
      await enabledCapture(pages);
      await run(pages, open);
      process.stdout.write(`[agreement] ${name}: passed ${Date.now() - start}ms\n`);
    } catch (error) {
      failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
      process.stdout.write(`[agreement] ${name}: FAILED ${Date.now() - start}ms: ${error.message}\n`);
      for (const context of contexts) {
        for (const page of context.pages()) {
          const peers = await page.evaluate(() => window.__chalk?.peerStates()).catch(() => null);
          process.stdout.write(`[agreement peers] ${JSON.stringify(peers)}\n`);
        }
      }
    } finally {
      // Each scenario has fresh identities and clients; never carry a poisoned
      // socket, permission, track or local media intent into the next case.
      for (const context of contexts) {
        for (const page of context.pages()) {
          await invoke(page, "leave").catch(() => {});
          await invoke(page, "dispose").catch(() => {});
        }
        await context.close();
      }
      await fault({ clear: true });
    }
  }
  async function fault(configuration) {
    const response = await fetch(`${baseURL}/test/fault`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participant: "agreementalice", ...configuration }) });
    assert.equal(response.ok, true, `Fault injection HTTP ${response.status}`);
  }
  async function dropMedia() {
    const response = await fetch(`${baseURL}/test/force-media?participant=agreementalice`, { method: "POST" });
    assert.equal(response.status, 202);
  }
  async function truth(pages) {
    assert.deepEqual(truthIssues(await Promise.all(pages.map((page) => page.evaluate(sampleAgreement)))), []);
  }
  async function enabledCapture(pages) {
    for (const page of pages) await page.waitForFunction(() => ["microphone", "camera"].every((source) => window.__chalk.snapshot().localMedia[source].state === "enabled"), null, { timeout: recoveryTimeoutMs });
  }
  await scenario("join and every microphone/camera toggle", async (pages) => {
    for (const owner of pages)
      for (const action of ["setMicrophoneEnabled", "setCameraEnabled"])
        for (const enabled of [false, true]) {
          await invoke(owner, action, enabled);
          const state = await owner.evaluate(() => window.__chalk.snapshot().localMedia);
          assert.equal(state[action === "setMicrophoneEnabled" ? "microphone" : "camera"].state, enabled ? "enabled" : "disabled");
          await assertAgreement(pages);
        }
  });
  if (fast) {
    if (failures.length) throw new AggregateError(failures, "Fast media agreement failed");
    return;
  }
  for (const projection of ["drop", "delay", "reject"])
    await scenario(`Sync media update ${projection}`, async (pages) => {
      await invoke(pages[0], "setMicrophoneEnabled", false);
      await assertAgreement(pages);
      await fault({ projection, durationMs: 2000 });
      const unmute = invoke(pages[0], "setMicrophoneEnabled", true).catch((error) => error);
      // Hold Sync behind a successful publication, rather than delaying capture.
      await wait(300);
      let failure;
      try {
        await truth(pages);
      } catch (error) {
        failure = error;
      }
      await fault({ clear: true });
      await unmute;
      await invoke(pages[0], "setMicrophoneEnabled", true);
      await enabledCapture(pages);
      await assertAgreement(pages);
      if (failure) throw failure;
    });
  await scenario("Sync reconnect during unmute", async (pages) => {
    await invoke(pages[0], "setMicrophoneEnabled", false);
    await assertAgreement(pages);
    await fault({ syncReconnect: true });
    const unmute = invoke(pages[0], "setMicrophoneEnabled", true).catch((error) => error);
    await unmute;
    await waitForState(pages[0], "live", recoveryTimeoutMs);
    await assertAgreement(pages);
  });
  for (const event of ["mute", "ended"])
    await scenario(`OS microphone ${event}`, async (pages) => {
      await invoke(pages[0], "interruptMicrophone", event);
      await assertAgreement(pages);
      assert.notEqual((await pages[0].evaluate(() => window.__chalk.snapshot())).localMedia.microphone.state, "enabled", "Interrupted capture must not remain normal On");
    });
  for (const hold of [true, false])
    await scenario(`${hold ? "Held media transport" : "SFU 503"} recovery beyond ten seconds; Sync healthy`, async (pages) => {
      await pages[0].bringToFront();
      assert.equal(await pages[0].evaluate(() => document.visibilityState), "visible");
      await fault({ status: 503, hold, durationMs: 12_000 });
      await dropMedia();
      await wait(10_500);
      const snapshot = await pages[0].evaluate(() => window.__chalk.snapshot());
      assert.notEqual(snapshot.state, "failed", "Healthy Sync must not become terminal after the media retry budget");
      assert.notEqual(snapshot.failure?.code, "connection.media_recovery_exhausted", "Media recovery gave up before the foreground recovery budget");
      // A successful collaboration roundtrip proves Sync was not dropped too.
      const message = await invoke(pages[0], "sendChatMessage", { text: "Sync alive during media recovery" });
      await pages[1].waitForFunction((id) => window.__chalk.snapshot().chat.messages.some((item) => item.clientMessageId === id), message.clientMessageId);
      await truth(pages);
      await waitForState(pages[0], "live", recoveryTimeoutMs);
      await enabledCapture(pages);
      await assertAgreement(pages, { timeoutMs: recoveryTimeoutMs });
      assert.equal((await pages[0].evaluate(() => window.__chalk.connectionHistory())).includes("failed"), false, "Media loss became terminal while Sync was healthy");
      assert.equal((await pages[0].evaluate(() => window.__chalk.connectionErrorHistory())).includes("connection.media_recovery_exhausted"), false, "Media recovery exhausted early, even if a later background attempt succeeded");
    });
  for (const status of [401, 403])
    await scenario(`Current SFU ${status} during recovery is terminal and truthful`, async (pages, open) => {
      await fault({ status, durationMs: 12_000 });
      await dropMedia();
      await waitForState(pages[0], "failed", recoveryTimeoutMs);
      const failed = await pages[0].evaluate(() => window.__chalk.snapshot());
      assert.equal(failed.failure?.code, "access.invalid");
      for (const source of ["microphone", "camera"]) assert.notEqual(failed.localMedia[source].state, "enabled");
      await pages[0].getByRole("heading", { name: /^Couldn’t connect to / }).waitFor();
      assert.match(failed.failure.message, /access was rejected/i);
      await pages[0].getByText(failed.failure.message, { exact: true }).waitFor();
      assert.equal(await pages[0].getByRole("button", { name: "Try again", exact: true }).count(), 1);
      assert.equal(await pages[0].getByRole("button", { name: "Mute microphone", exact: true }).count(), 0);
      assert.equal(await pages[0].getByRole("button", { name: "Turn off camera", exact: true }).count(), 0);
      assert.deepEqual(await pages[0].evaluate(() => window.__chalk.resources()), { tracks: 0, sockets: 0, peers: 0, timers: 0 });
      await fault({ clear: true });
      const replacement = await open("agreementalice");
      await enabledCapture([replacement, pages[1]]);
      await assertAgreement([replacement, pages[1]], { timeoutMs: recoveryTimeoutMs });
    });
  await scenario("same participant takes over during media recovery", async (pages, open) => {
    await fault({ status: 503, durationMs: 12_000 });
    await dropMedia();
    await wait(500);
    await fault({ clear: true });
    const replacement = await open("agreementalice");
    await enabledCapture([replacement, pages[1]]);
    await assertAgreement([replacement, pages[1]], { timeoutMs: recoveryTimeoutMs });
    // The superseded tab must not regain publication authority in the background.
    await waitForState(pages[0], "failed", recoveryTimeoutMs);
    assert.deepEqual(await pages[0].evaluate(() => window.__chalk.resources()), { tracks: 0, sockets: 0, peers: 0, timers: 0 });
    await assertAgreement([replacement, pages[1]]);
  });
  if (failures.length) throw new AggregateError(failures, `${failures.length} media agreement scenarios failed`);
}
