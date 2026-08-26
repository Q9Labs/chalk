import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertRoster, joinParticipant, reenterParticipant } from "./browser.mjs";
import { aggregateFailures, StepFailure, TraceLifecycleError, isFeatureDispositionError } from "./errors.mjs";
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

function boundedDiagnosticText(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return "unserializable";
  }
  return text.length > 8_000 ? `${text.slice(0, 7_997)}...` : text;
}

async function cameraDiagnosticSummary(person) {
  try {
    return await scenario.summarizePeerConnections(person.page);
  } catch (error) {
    return { unavailable: errorText(error) };
  }
}

async function assertRemoteCameraStateWithDiagnostics(actor, observer, enabled) {
  try {
    await scenario.assertRemoteCameraState(observer.page, actor.name, enabled);
  } catch (error) {
    if (!enabled) throw error;
    const [actorSummary, observerSummary] = await Promise.all([cameraDiagnosticSummary(actor), cameraDiagnosticSummary(observer)]);
    throw new Error(`${errorText(error)}; actor ${actor.name} WebRTC=${boundedDiagnosticText(actorSummary)}; observer ${observer.name} WebRTC=${boundedDiagnosticText(observerSummary)}`, { cause: error });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function supportFailed(recorder, feature) {
  return recorder.supportStatus(feature) === "failed";
}

export function shouldContinueCycles(measurement, now, deadline) {
  return measurement.singleCycle !== true && now < deadline;
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
      if (error instanceof TraceLifecycleError) throw error;
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
      let completedToggles = 0;
      try {
        const firstActive = await scenario.toggleMicrophone(actor.page);
        completedToggles += 1;
        if (firstActive) throw new Error("microphone did not enter the muted state");
        await scenario.assertRemoteMicrophoneState(observer.page, actor.name, firstActive);
        const secondActive = await scenario.toggleMicrophone(actor.page);
        completedToggles += 1;
        if (!secondActive) throw new Error("microphone did not return to the active state");
        await scenario.assertRemoteMicrophoneState(observer.page, actor.name, secondActive);
        return true;
      } finally {
        if (completedToggles % 2 === 1) {
          const restoredActive = await scenario.toggleMicrophone(actor.page);
          await scenario.assertRemoteMicrophoneState(observer.page, actor.name, restoredActive);
        }
      }
    },
    { feature: "microphone" },
  );
  if (!supportFailed(recorder, "camera-video")) {
    await recorder.step(`microphone command quiet window ${cycle}`, () => wait(5_000, state.signal));
    const cameraReady = await recorder.step(
      `camera initial playback ${cycle}`,
      async () => {
        await assertRemoteCameraStateWithDiagnostics(actor, observer, true);
        return true;
      },
      { feature: "camera-video" },
    );
    if (cameraReady) {
      await recorder.step(
        `camera video trace ${cycle}`,
        () =>
          trace("camera-video", cycle, async () => {
            let completedToggles = 0;
            try {
              const firstState = await scenario.toggleCamera(actor.page);
              completedToggles += 1;
              if (firstState) throw new Error("camera did not enter the disabled state");
              await assertRemoteCameraStateWithDiagnostics(actor, observer, firstState);
              await wait(1_000, state.signal);
              const secondState = await scenario.toggleCamera(actor.page);
              completedToggles += 1;
              if (!secondState) throw new Error("camera did not return to the enabled state");
              await assertRemoteCameraStateWithDiagnostics(actor, observer, secondState);
              await wait(1_000, state.signal);
            } finally {
              if (completedToggles % 2 === 1) {
                const restoredState = await scenario.toggleCamera(actor.page);
                await assertRemoteCameraStateWithDiagnostics(actor, observer, restoredState);
              }
            }
          }),
        { feature: "camera-video" },
      );
    }
  }
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
        let raised = false;
        let actionError = null;
        try {
          await scenario.toggleHandRaise(remote.page);
          raised = true;
          await scenario.assertRemoteHand(anchor.page);
          await wait(2_000, state.signal);
        } catch (error) {
          actionError = error;
          throw error;
        } finally {
          if (raised) {
            try {
              await scenario.toggleHandRaise(remote.page);
            } catch (error) {
              if (!actionError) throw error;
            }
          }
        }
      }),
    { feature: "hand-raise" },
  );
}

const defaultScreenShareCommands = {
  assertRemoteShare: scenario.assertRemoteShare,
  screenShareFailureDetail: scenario.screenShareFailureDetail,
  toggleScreenShare: scenario.toggleScreenShare,
  wait,
  zoomPanScreenShare: scenario.zoomPanScreenShare,
};

function screenShareOperationAndCleanupFailure(operationError, cleanupError) {
  const cause = new AggregateError([operationError, cleanupError], `${errorText(operationError)}; screen share cleanup failed: ${errorText(cleanupError)}`);
  if (operationError instanceof TraceLifecycleError) {
    return new TraceLifecycleError(`${operationError.message}; screen share cleanup failed`, { cause, result: operationError.result });
  }
  return cause;
}

export async function runScreenShare(state, cycle, commands = defaultScreenShareCommands) {
  const { people, anchor, recorder, trace } = state;
  const remote = people[1];
  if (supportFailed(recorder, "screen-share") || supportFailed(recorder, "screen-share-zoom-pan")) return;
  let shareActive = false;
  let cleanupAttempted = false;

  const stopShare = async () => {
    if (!shareActive || cleanupAttempted) return;
    cleanupAttempted = true;
    let active;
    try {
      active = await commands.toggleScreenShare(remote.page);
    } catch (error) {
      const message = errorText(error);
      let detail;
      try {
        detail = await commands.screenShareFailureDetail(remote.page);
      } catch (detailError) {
        throw new AggregateError([error, detailError], `${message}: screen share cleanup detail failed`);
      }
      throw new Error(`${message}: ${detail}`, { cause: error });
    }
    if (active) throw new Error("screen share stayed active after stop");
    shareActive = false;
    await commands.assertRemoteShare(anchor.page, remote.name, false);
  };

  const traceWithCleanup = async (feature, action) => {
    let operationError = null;
    try {
      await trace(feature, cycle, action);
      return true;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (operationError && shareActive) {
        try {
          await stopShare();
        } catch (cleanupError) {
          throw screenShareOperationAndCleanupFailure(operationError, cleanupError);
        }
      }
    }
  };

  await recorder.step(`screen share command quiet window ${cycle}`, () => commands.wait(5_000, state.signal));
  let operationError = null;
  try {
    const videoTrace = await recorder.step(
      `screen share video trace ${cycle}`,
      () =>
        traceWithCleanup("screen-share-video", async () => {
          const active = await commands.toggleScreenShare(remote.page);
          if (!active) throw new Error(`screen share did not enter the active state: ${await commands.screenShareFailureDetail(remote.page)}`);
          shareActive = true;
          await commands.assertRemoteShare(anchor.page, remote.name, true);
          await commands.wait(1_500, state.signal);
        }),
      { feature: "screen-share" },
    );
    if (!videoTrace) return;

    const zoomTrace = await recorder.step(`screen share zoom and pan trace ${cycle}`, () => traceWithCleanup("screen-share-zoom-pan", () => commands.zoomPanScreenShare(anchor.page, remote.name)), { feature: "screen-share-zoom-pan" });
    if (!zoomTrace) return;

    await recorder.step(`screen share stop ${cycle}`, () => stopShare(), { feature: "screen-share" });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (operationError && shareActive && !cleanupAttempted) {
      try {
        await stopShare();
      } catch (cleanupError) {
        throw screenShareOperationAndCleanupFailure(operationError, cleanupError);
      }
    }
  }
}

async function runPanels(state, cycle) {
  const { anchor, recorder, snapshot, trace } = state;
  for (const kind of scenario.panelKinds()) {
    const feature = `${kind}-panel`;
    if (cycle > 1 && supportFailed(recorder, feature)) continue;
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
        await recorder.step(`observe remote whiteboard ${remote.name} ${cycle}`, () => scenario.waitForPanelState(remote.page, "whiteboard", true), { feature: "whiteboard-remote-cursors" });
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
    }
    await recorder.step(`close ${kind} panel ${cycle}`, () => scenario.closePanel(anchor.page, kind), { feature });
    if (kind === "whiteboard") {
      for (const remote of state.people.slice(1)) {
        await recorder.step(`observe remote whiteboard closed ${remote.name} ${cycle}`, () => scenario.waitForPanelState(remote.page, "whiteboard", false), { feature: "whiteboard-remote-cursors" });
      }
    }
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
  if (!supportFailed(recorder, "chat-file-upload")) {
    await recorder.step(
      `chat file upload ${cycle}`,
      async () => {
        const fileName = await scenario.uploadChatFile(anchor.page, fixturePath);
        await remote.page
          .getByRole("button", { name: new RegExp(`^Download ${escapeRegExp(fileName)}$`, "i") })
          .last()
          .waitFor({ state: "visible", timeout: 20_000 });
      },
      { feature: "chat-file-upload" },
    );
  }
  await recorder.step(`close remote chat ${cycle}`, () => scenario.closePanel(remote.page, "chat"), { feature: "chat-receive" });
}

const defaultLeaveRejoinCommands = { assertRoster, leaveSpace: scenario.leaveSpace, reenterParticipant };

export async function runLeaveRejoin(state, cycle, commands = defaultLeaveRejoinCommands) {
  const { people, anchor, recorder, snapshot } = state;
  if (cycle === 1) await snapshot(`anchor-before-remote-leave-${cycle}`, anchor);
  const remote = people[1];
  const left = await recorder.step(
    `remote leave ${cycle}`,
    async () => {
      await commands.leaveSpace(remote.page);
      return true;
    },
    { feature: "leave-rejoin" },
  );
  if (!left) return;
  await recorder.step(`roster after remote leave ${cycle}`, () => commands.assertRoster(anchor.page, people.length - 1), { feature: "roster" });
  if (cycle === 1) await snapshot(`anchor-after-remote-leave-${cycle}`, anchor);
  const rejoined = await recorder.step(`remote rejoin ${cycle}`, () => commands.reenterParticipant(remote), { feature: "leave-rejoin" });
  if (!rejoined) return;
  await recorder.step(`roster after remote rejoin ${cycle}`, () => commands.assertRoster(anchor.page, people.length), { feature: "roster" });
  if (cycle === 1) await snapshot(`anchor-after-remote-rejoin-${cycle}`, anchor);
}

export async function runWorkload(state) {
  await runJoinPhase(state);
  const measurement = state.measurement ?? {
    cpuProfiles: state.options.snapshotPass !== true,
    singleCycle: state.options.snapshotPass === true,
  };
  if (state.options.focus) return runFocusedCorrectness(state, state.options.focus);
  if (measurement.cpuProfiles) await state.startCpuProfiles();
  const startedAt = Date.now();
  const deadline = startedAt + state.options.durationMs;
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
    cycle += 1;
  } while (shouldContinueCycles(measurement, Date.now(), deadline));
  await runLeaveRejoin(state, cycle - 1);
  return { cycles: cycle - 1, startedAt, finishedAt: Date.now(), actualDurationMs: Date.now() - startedAt };
}

async function runFocusedCorrectness(state, focus) {
  const startedAt = Date.now();
  if (focus === "leave-rejoin") {
    await runLeaveRejoin(state, 1);
  } else if (focus === "whiteboard") {
    const remotes = state.people.slice(1);
    await state.recorder.step("whiteboard focused Grid layout", () => scenario.switchLayout(state.anchor.page, "grid"), { feature: "layouts" });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await state.recorder.step(`open whiteboard focused ${cycle}`, () => scenario.openPanel(state.anchor.page, "whiteboard"), { feature: "whiteboard-panel" });
      try {
        for (const remote of remotes) await state.recorder.step(`observe remote whiteboard focused ${remote.name} ${cycle}`, () => scenario.waitForPanelState(remote.page, "whiteboard", true), { feature: "whiteboard-remote-cursors" });
        await state.recorder.step(`whiteboard draw focused ${cycle}`, () => scenario.drawWhiteboard(state.anchor.page), { feature: "whiteboard" });
        await state.recorder.step(`whiteboard pan and zoom focused ${cycle}`, () => scenario.panZoomWhiteboard(state.anchor.page), { feature: "whiteboard" });
        await state.recorder.step(
          `whiteboard remote cursors focused ${cycle}`,
          () =>
            scenario.moveRemoteWhiteboardCursors(
              state.anchor.page,
              remotes.map((remote) => remote.page),
            ),
          { feature: "whiteboard-remote-cursors" },
        );
      } finally {
        await state.recorder.step(`close whiteboard focused ${cycle}`, () => scenario.closePanel(state.anchor.page, "whiteboard"), { feature: "whiteboard-panel" });
        for (const remote of remotes) await state.recorder.step(`observe remote whiteboard closed focused ${remote.name} ${cycle}`, () => scenario.waitForPanelState(remote.page, "whiteboard", false), { feature: "whiteboard-remote-cursors" });
      }
    }
  } else {
    for (let cycle = 1; cycle <= state.people.length; cycle += 1) await runMediaAndLayout(state, cycle);
    await runScreenShare(state, 1);
    await runScreenShare(state, 2);
  }
  return { cycles: focus === "whiteboard" ? 3 : focus === "media" ? state.people.length : 1, startedAt, finishedAt: Date.now(), actualDurationMs: Date.now() - startedAt };
}
