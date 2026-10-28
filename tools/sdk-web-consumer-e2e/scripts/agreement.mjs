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
    const evidence = new Map();
    try {
      const open = async (participant) => {
        const context = await browser.newContext({ ...device, permissions: ["camera", "microphone"] });
        contexts.push(context);
        const reports = [];
        await context.route("**/connection-reports", async (route) => {
          reports.push(route.request().postDataJSON());
          await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
        });
        await context.addInitScript(installAgreementProbe);
        const page = await context.newPage();
        const commands = [];
        page.on("websocket", (socket) =>
          socket.on("framesent", ({ payload }) => {
            const message = JSON.parse(String(payload));
            if (message.type === "command") commands.push(message);
          }),
        );
        evidence.set(page, { reports, commands });
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
      await enabledCapture(pages);
      await assertAgreement(pages);
      await run(pages, open, evidence);
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
  async function clickControl(page, name) {
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 10, height / 2 + 10);
    await page.getByRole("toolbar", { name: "Space controls", exact: true }).hover();
    await page.getByRole("button", { name, exact: true }).click();
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
  for (const source of ["microphone", "camera"])
    for (const projection of ["drop", "delay", "reject"])
      await scenario(`Sync ${source} update ${projection}: fail closed and one-tap recovery`, async (pages, _open, evidence) => {
        const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
        const command = source === "microphone" ? "set_microphone_enabled" : "set_camera_enabled";
        const { commands, reports } = evidence.get(pages[0]);
        await invoke(pages[0], action, false);
        await assertAgreement(pages);
        const initialCommands = commands.length;
        await fault({ projection, durationMs: 12_000 });
        const unmute = invoke(pages[0], action, true).catch((error) => error);
        // Hold Sync behind a successful publication, rather than delaying capture.
        await wait(300);
        let failure;
        try {
          await truth(pages);
        } catch (error) {
          failure = error;
        }
        await unmute;
        await pages[0].waitForFunction((source) => window.__chalk.snapshot().localMedia[source].state === "failed", source, { timeout: 15_000 });
        assert.equal(await pages[0].evaluate((source) => window.__chalk.agreementSnapshot().media.local[source].track?.enabled ?? false, source), false, "Failed capture must be physically paused");
        await assertAgreement(pages);
        await pages[0].getByText(`${source === "microphone" ? "Microphone" : "Camera"} didn’t reach the call. Turn it on to try again.`, { exact: true }).waitFor();
        await wait(2000);
        const mismatch = reports.filter((report) => report.trigger === "media_projection_mismatch");
        assert.equal(mismatch.length, 1, "Persistent drift sends one report");
        assert.deepEqual(
          mismatch[0].events.filter((event) => event.event === "media_projection_mismatch").map(({ source, attempt, outcome }) => ({ source, attempt, outcome })),
          [{ source, attempt: 0, outcome: "failed" }],
        );
        assert.equal(commands.slice(initialCommands).filter((message) => message.name === command).length, 1, "The monitor must not send automatic repair targets");
        await fault({ clear: true });
        await assertAgreement(pages);
        // Use the person's actual control, not a second SDK enable that could
        // hide a toggle which merely cancels an already failed action.
        await clickControl(pages[0], source === "microphone" ? "Unmute microphone" : "Turn on camera");
        await enabledCapture(pages);
        await assertAgreement(pages);
        assert.equal(commands.slice(initialCommands).filter((message) => message.name === command).length, 2, "One fresh tap sends exactly one enable");
        assert.equal(reports.filter((report) => report.trigger === "media_projection_mismatch").length, 1);
        if (failure) throw failure;
      });
  for (const source of ["microphone", "camera"]) {
    const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
    await scenario(`Sync ${source} confirms within grace`, async (pages, _open, evidence) => {
      await invoke(pages[0], action, false);
      await assertAgreement(pages);
      await fault({ projection: "delay", durationMs: 2000 });
      await invoke(pages[0], action, true);
      await wait(300);
      await truth(pages);
      await pages[0].getByRole("button", { name: `Cancel connecting ${source}`, exact: true }).waitFor();
      await enabledCapture(pages);
      await assertAgreement(pages);
      assert.equal(evidence.get(pages[0]).reports.length, 0);
    });
    await scenario(`Pending ${source} cancels with shortcut and recovers with button`, async (pages, _open, evidence) => {
      await invoke(pages[0], action, false);
      await assertAgreement(pages);
      await fault({ projection: "drop", durationMs: 12_000 });
      await invoke(pages[0], action, true);
      await pages[0].getByRole("button", { name: `Cancel connecting ${source}`, exact: true }).waitFor();
      await pages[0].keyboard.press(source === "microphone" ? "Control+d" : "Control+e");
      await assertAgreement(pages);
      assert.equal(await pages[0].evaluate((source) => window.__chalk.agreementSnapshot().media.local[source].track?.enabled ?? false, source), false);
      await fault({ clear: true });
      await clickControl(pages[0], source === "microphone" ? "Unmute microphone" : "Turn on camera");
      await enabledCapture(pages);
      await assertAgreement(pages);
      assert.equal(evidence.get(pages[0]).reports.length, 0);
    });
  }
  await scenario("Sync reconnect during unmute", async (pages) => {
    await invoke(pages[0], "setMicrophoneEnabled", false);
    await assertAgreement(pages);
    await fault({ syncReconnect: true });
    const unmute = invoke(pages[0], "setMicrophoneEnabled", true).catch((error) => error);
    await unmute;
    await waitForState(pages[0], "live", recoveryTimeoutMs);
    // Reconnect may reject the interrupted command. Its settled UI must still
    // agree before a fresh user unmute restores audible capture.
    await assertAgreement(pages, { timeoutMs: recoveryTimeoutMs });
    await invoke(pages[0], "setMicrophoneEnabled", true);
    await enabledCapture(pages);
    await assertAgreement(pages);
  });
  for (const event of ["mute", "ended"])
    await scenario(`OS microphone ${event}`, async (pages) => {
      await invoke(pages[0], "interruptMicrophone", event);
      await assertAgreement(pages);
      assert.notEqual((await pages[0].evaluate(() => window.__chalk.snapshot())).localMedia.microphone.state, "enabled", "Interrupted capture must not remain normal On");
      await clickControl(pages[0], "Unmute microphone");
      await enabledCapture(pages);
      await assertAgreement(pages);
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
