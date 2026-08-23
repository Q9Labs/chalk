import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertRoster, joinParticipant } from "./browser.mjs";
import { aggregateFailures, StepFailure, isFeatureDispositionError } from "./errors.mjs";
import * as scenario from "./scenario.mjs";

function wait(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Space profile interrupted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Space profile interrupted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertActive(state) {
  if (state.signal?.aborted) throw state.signal.reason ?? new Error("Space profile interrupted");
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createRecorder(outDir) {
  const stepsPath = join(outDir, "steps.ndjson");
  const support = new Map();
  const failures = [];

  async function step(label, action, { feature = "workload", allowDisposition = false } = {}) {
    const startedAt = Date.now();
    try {
      const result = await action();
      await appendFile(stepsPath, `${JSON.stringify({ event: "step", label, feature, ok: true, startedAt, finishedAt: Date.now(), ms: Date.now() - startedAt })}\n`);
      if (feature !== "workload") updateSupport(feature, "reachable", { label });
      return result;
    } catch (error) {
      const disposition = isFeatureDispositionError(error);
      const kind = disposition ? error.kind : "failed";
      await appendFile(stepsPath, `${JSON.stringify({ event: "step", label, feature, ok: false, startedAt, finishedAt: Date.now(), ms: Date.now() - startedAt, disposition: kind, allowedDisposition: disposition && allowDisposition, error: errorText(error) })}\n`);
      if (feature !== "workload") updateSupport(feature, disposition && allowDisposition ? kind : "failed", { label, reason: errorText(error), disposition: disposition ? kind : undefined });
      if (!disposition || !allowDisposition) failures.push(new StepFailure(label, error));
      return null;
    }
  }

  function updateSupport(feature, status, evidence) {
    const current = support.get(feature) ?? { feature, status, attempts: 0, evidence: [] };
    current.attempts += 1;
    if (status === "failed" || current.status === undefined || (status === "reachable" && current.status !== "failed")) current.status = status;
    current.evidence.push({ ...evidence, status, at: new Date().toISOString() });
    support.set(feature, current);
  }

  return {
    step,
    updateSupport,
    supportStatus(feature) {
      return support.get(feature)?.status ?? null;
    },
    get failures() {
      return [...failures];
    },
    async writeSupport() {
      const features = [...support.values()].sort((left, right) => left.feature.localeCompare(right.feature));
      await writeFile(join(outDir, "feature-support.json"), JSON.stringify({ generatedAt: new Date().toISOString(), features }, null, 2));
      return features;
    },
    failure() {
      return aggregateFailures("workload", failures);
    },
  };
}

async function runJoinPhase(state) {
  const { people, recorder, snapshot } = state;
  const anchor = people[0];
  const invite = await recorder.step("join anchor", () => joinParticipant(anchor), { feature: "joins" });
  if (!invite) throw new Error("anchor could not join the Space");
  state.inviteUrl = invite.toString();
  await recorder.step("roster after anchor join", () => assertRoster(anchor.page, 1), { feature: "roster" });
  await snapshot("anchor-after-self-join", anchor);
  for (const person of people.slice(1)) {
    const joined = await recorder.step(`join ${person.name}`, () => joinParticipant(person, state.inviteUrl), { feature: "joins" });
    if (!joined) throw new Error(`${person.name} could not join the Space`);
    await recorder.step(`roster after ${person.name} join`, () => assertRoster(anchor.page, person.index + 1), { feature: "roster" });
  }
  await snapshot("anchor-after-remote-joins", anchor);
}

async function runMediaAndLayout(state, cycle) {
  const { people, anchor, recorder, trace } = state;
  const actor = people[cycle % people.length];
  const observer = actor === anchor ? people[1] : anchor;
  await recorder.step(
    `microphone toggles ${cycle}`,
    async () => {
      await scenario.toggleMicrophone(actor.page);
      await scenario.toggleMicrophone(actor.page);
    },
    { feature: "microphone" },
  );
  await recorder.step(
    `camera video trace ${cycle}`,
    () =>
      trace("camera-video", cycle, async () => {
        const firstState = await scenario.toggleCamera(actor.page);
        await scenario.assertRemoteCameraState(observer.page, actor.name, firstState);
        await wait(1_000, state.signal);
        const secondState = await scenario.toggleCamera(actor.page);
        await scenario.assertRemoteCameraState(observer.page, actor.name, secondState);
        await wait(1_000, state.signal);
      }),
    { feature: "camera-video" },
  );
  await recorder.step(
    `layout changes ${cycle}`,
    async () => {
      for (const layout of ["grid", "spotlight", "presentation", "grid"]) await scenario.switchLayout(anchor.page, layout);
    },
    { feature: "layouts" },
  );
  await recorder.step(`tile click and pin ${cycle}`, () => scenario.clickAndPinTile(anchor.page, new RegExp(people[1].name)), { feature: "participant-tile-pin" });
  if (cycle === 1) await recorder.step(`tile drag support ${cycle}`, () => scenario.markTileDragUnsupported(anchor.page), { feature: "participant-tile-drag", allowDisposition: true });
}

async function runReactionAndHand(state, cycle) {
  const { people, anchor, recorder, trace } = state;
  const remote = people[1];
  await recorder.step(
    `reaction animation trace ${cycle}`,
    () =>
      trace("reaction-animation", cycle, async () => {
        await scenario.chooseReaction(remote.page, "👍");
        await scenario.assertRemoteReaction(anchor.page, remote.name, "👍");
      }),
    { feature: "reactions" },
  );
  await recorder.step(
    `hand animation trace ${cycle}`,
    () =>
      trace("hand-animation", cycle, async () => {
        await scenario.toggleHandRaise(remote.page);
        await scenario.assertRemoteHand(anchor.page);
        await wait(2_000, state.signal);
        await scenario.toggleHandRaise(remote.page);
      }),
    { feature: "hand-raise" },
  );
}

async function runScreenShare(state, cycle) {
  const { people, anchor, recorder, trace } = state;
  const remote = people[1];
  await recorder.step(
    `screen share video trace ${cycle}`,
    () =>
      trace("screen-share-video", cycle, async () => {
        const active = await scenario.toggleScreenShare(remote.page);
        if (!active) throw new Error("screen share did not enter the active state");
        await scenario.assertRemoteShare(anchor.page, remote.name, true);
        await wait(1_500, state.signal);
      }),
    { feature: "screen-share" },
  );
  await recorder.step(`screen share zoom and pan trace ${cycle}`, () => trace("screen-share-zoom-pan", cycle, () => scenario.zoomPanScreenShare(anchor.page, remote.name)), { feature: "screen-share-zoom-pan" });
  await recorder.step(
    `screen share stop ${cycle}`,
    async () => {
      const active = await scenario.toggleScreenShare(remote.page);
      if (active) throw new Error("screen share stayed active after stop");
      await scenario.assertRemoteShare(anchor.page, remote.name, false);
    },
    { feature: "screen-share" },
  );
}

async function runPanels(state, cycle) {
  const { anchor, recorder, snapshot, trace, fixturePath } = state;
  for (const kind of scenario.panelKinds()) {
    const feature = `${kind}-panel`;
    if (kind === "transcript") {
      if (cycle === 1) await recorder.step(`probe ${kind} panel ${cycle}`, () => scenario.openPanel(anchor.page, kind), { feature, allowDisposition: true });
      continue;
    }
    if (cycle === 1) await recorder.step(`${kind} panel baseline ${cycle}`, () => snapshot(`${kind}-baseline-${cycle}`, anchor));
    const surface = await recorder.step(`open ${kind} panel ${cycle}`, () => scenario.openPanel(anchor.page, kind), { feature });
    if (!surface) continue;
    if (cycle === 1) await recorder.step(`${kind} panel open snapshot ${cycle}`, () => snapshot(`${kind}-open-${cycle}`, anchor));
    if (kind === "chat") await runChat(state, cycle);
    if (kind === "participants" && (cycle === 1 || recorder.supportStatus("admission-waiting") === "reachable")) {
      await recorder.step(`participants Waiting tab ${cycle}`, () => scenario.exerciseWaitingParticipantsTab(anchor.page), { feature: "admission-waiting", allowDisposition: true });
    }
    if (kind === "whiteboard") {
      for (const remote of state.people.slice(1)) {
        await recorder.step(`open remote whiteboard ${remote.name} ${cycle}`, () => scenario.openPanel(remote.page, "whiteboard"), { feature: "whiteboard-remote-cursors" });
      }
      await recorder.step(
        `whiteboard draw pan zoom trace ${cycle}`,
        () =>
          trace("whiteboard-draw-pan-zoom", cycle, async () => {
            await scenario.drawWhiteboard(anchor.page);
            await scenario.panZoomWhiteboard(anchor.page);
          }),
        { feature: "whiteboard" },
      );
      await recorder.step(
        `whiteboard remote cursor trace ${cycle}`,
        () =>
          trace("whiteboard-remote-cursors", cycle, () =>
            scenario.moveRemoteWhiteboardCursors(
              anchor.page,
              state.people.slice(1).map((remote) => remote.page),
            ),
          ),
        { feature: "whiteboard-remote-cursors" },
      );
      for (const remote of state.people.slice(1)) {
        await recorder.step(`close remote whiteboard ${remote.name} ${cycle}`, () => scenario.closePanel(remote.page, "whiteboard"), { feature: "whiteboard-remote-cursors" });
      }
    }
    await recorder.step(`close ${kind} panel ${cycle}`, () => scenario.closePanel(anchor.page, kind), { feature });
    if (cycle === 1) await recorder.step(`${kind} panel closed snapshot ${cycle}`, () => snapshot(`${kind}-closed-${cycle}`, anchor));
  }
}

async function runChat(state, cycle) {
  const { anchor, people, recorder, fixturePath, trace } = state;
  const remote = people[1];
  const anchorText = `Space profile ${cycle} from ${anchor.name}`;
  await recorder.step(`chat send ${cycle}`, () => scenario.sendChatMessage(anchor.page, anchorText), { feature: "chat-send" });
  await recorder.step(
    `chat receive ${cycle}`,
    async () => {
      await scenario.openPanel(remote.page, "chat");
      await remote.page.getByText(anchorText, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      const remoteText = `Space profile ${cycle} from ${remote.name}`;
      await scenario.sendChatMessage(remote.page, remoteText);
      await anchor.page.getByText(remoteText, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    },
    { feature: "chat-receive" },
  );
  await recorder.step(
    `chat history seed ${cycle}`,
    async () => {
      const messageCount = cycle === 1 ? 28 : 6;
      for (let index = 0; index < messageCount; index += 1) await scenario.sendChatMessage(anchor.page, `${anchorText}-history-${index}`);
    },
    { feature: "chat-history" },
  );
  await recorder.step(`chat history scroll trace ${cycle}`, () => trace("chat-history-scroll", cycle, () => scenario.scrollChatHistory(anchor.page)), { feature: "chat-history" });
  await recorder.step(
    `chat file upload ${cycle}`,
    async () => {
      const fileName = await scenario.uploadChatFile(anchor.page, fixturePath);
      await remote.page.getByText(fileName, { exact: true }).last().waitFor({ state: "visible", timeout: 20_000 });
    },
    { feature: "chat-file-upload" },
  );
  await recorder.step(`close remote chat ${cycle}`, () => scenario.closePanel(remote.page, "chat"), { feature: "chat-receive" });
}

async function runLeaveRejoin(state, cycle) {
  const { people, anchor, recorder, snapshot, inviteUrl } = state;
  if (cycle === 1) await snapshot(`anchor-before-remote-leave-${cycle}`, anchor);
  const remote = people[1];
  await recorder.step(`remote leave ${cycle}`, () => scenario.leaveSpace(remote.page), { feature: "leave-rejoin" });
  await recorder.step(`roster after remote leave ${cycle}`, () => assertRoster(anchor.page, people.length - 1), { feature: "roster" });
  if (cycle === 1) await snapshot(`anchor-after-remote-leave-${cycle}`, anchor);
  const rejoined = await recorder.step(`remote rejoin ${cycle}`, () => joinParticipant(remote, inviteUrl), { feature: "leave-rejoin" });
  if (!rejoined) throw new Error(`${remote.name} could not rejoin the Space`);
  await recorder.step(`roster after remote rejoin ${cycle}`, () => assertRoster(anchor.page, people.length), { feature: "roster" });
  if (cycle === 1) await snapshot(`anchor-after-remote-rejoin-${cycle}`, anchor);
}

export async function runWorkload(state) {
  const startedAt = Date.now();
  const deadline = startedAt + state.options.durationMs;
  await runJoinPhase(state);
  const idleMs = state.options.mode === "profile" ? 15_000 : 5_000;
  await state.recorder.step("explicit idle trace", () => state.trace("idle", 0, () => wait(idleMs, state.signal)), { feature: "idle" });
  let cycle = 1;
  do {
    assertActive(state);
    await runMediaAndLayout(state, cycle);
    assertActive(state);
    await runReactionAndHand(state, cycle);
    assertActive(state);
    await runScreenShare(state, cycle);
    assertActive(state);
    await runPanels(state, cycle);
    await state.recorder.step(`idle window ${cycle}`, () => wait(state.options.mode === "profile" ? 20_000 : 5_000, state.signal), { feature: "idle" });
    if (cycle === 1 || (state.options.mode === "profile" && cycle === 2)) await runLeaveRejoin(state, cycle);
    cycle += 1;
  } while (Date.now() < deadline);
  return { cycles: cycle - 1, startedAt, finishedAt: Date.now(), actualDurationMs: Date.now() - startedAt };
}
