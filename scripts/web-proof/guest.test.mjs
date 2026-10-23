import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fixture } from "./fixtures/guest-media.mjs";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === new URL("./guest.mjs", import.meta.url).href && specifier === "../prod-proof/media.mjs") {
      return { url: new URL("./fixtures/guest-media.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { withProofCall } = await import("./guest.mjs");
hooks.deregister();

test("a proof retains its assertion and every cleanup failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-proof-cleanup-"));
  const environment = {
    CHALK_E2E_INVITE: "/space/test",
    CHALK_E2E_DIRECTORY: directory,
    CHALK_E2E_API_KEY: "chalk_sk_test_fixture",
    CHALK_E2E_API_URL: "https://api.example.test",
    CHALK_E2E_TENANT_ID: "tenant",
    CHALK_PROOF_WEB_URL: "https://web.example.test",
    CHALK_E2E_PROOF_ORIGIN: "http://127.0.0.1:4567",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "space.json"), JSON.stringify({ id: "space" }));
  await writeFile(join(directory, "episode.json"), JSON.stringify({ id: "episode" }));

  const scenarios = [
    { failures: [], name: "successful call" },
    { failures: ["assertion"] },
    { failures: ["assertion", "web-leave"] },
    { failures: ["assertion", "sdk-leave"] },
    { failures: ["assertion", "web-leave", "sdk-leave", "browser-close"] },
    { failures: ["web-leave", "browser-close"] },
    { failures: ["assertion", "web-complete", "browser-close"] },
    { failures: ["sdk-leave", "browser-close"], callbackLeave: true, name: "callback awaits a rejected SDK leave" },
  ];
  for (const { failures, callbackLeave, name } of scenarios) {
    await t.test(name ?? failures.join(" + "), async () => {
      const errors = new Map(failures.map((name) => [name, new Error(name)]));
      const calls = [];
      const step = (name) => async () => {
        calls.push(name);
        if (errors.has(name)) throw errors.get(name);
      };
      fixture.leave = step("sdk-leave");
      fixture.dispose = step("browser-close");
      const screen = {
        getByLabel: () => ({ fill: async () => {} }),
        getByRole: (_role, name, options) => ({
          count: async () => 1,
          click: name === "Leave call" ? step("web-leave") : async () => {},
          async waitFor(waitOptions) {
            assert.equal(name, "Rejoin");
            assert.equal(options.disabled, false);
            assert.deepEqual(waitOptions, { state: "visible", timeout: 15_000 });
            await step("web-complete")();
          },
        }),
      };
      const result = withProofCall({ app: { open: async () => {} }, screen }, callbackLeave ? (guest) => guest.leave() : step("assertion"));
      const flatten = (entry) => (entry instanceof AggregateError ? entry.errors.flatMap(flatten) : [entry]);
      const actual = await result.then(() => [], flatten);
      assert.deepEqual(actual, [...errors.values()]);
      actual.forEach((error) => assert.equal(error, errors.get(error.message)));
      const expected = callbackLeave ? ["sdk-leave", "web-leave", "browser-close"] : ["assertion", "web-leave", "sdk-leave", "browser-close"];
      if (!failures.includes("web-leave")) expected.splice(2, 0, "web-complete");
      assert.deepEqual(calls, expected);
    });
  }

  for (const [callbackLeave, timeout] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])
    await t.test(`pending web leave: callback=${callbackLeave}, timeout=${timeout}`, async () => {
      const clicked = Promise.withResolvers();
      const completed = Promise.withResolvers();
      completed.promise.catch(() => {});
      const failure = new Error("Web leave did not complete within 15000ms");
      let disposed = false;
      let webLeaving = false;
      fixture.leave = async () => {};
      fixture.dispose = async () => {
        disposed = true;
      };
      const screen = {
        getByLabel: () => ({ fill: async () => {} }),
        getByRole: (_role, name, options) => ({
          count: async () => (webLeaving ? 0 : 1),
          click: async () => {
            if (name !== "Leave call") return;
            webLeaving = true;
            clicked.resolve();
          },
          async waitFor(waitOptions) {
            assert.equal(name, "Rejoin");
            assert.equal(options.disabled, false);
            assert.deepEqual(waitOptions, { state: "visible", timeout: 15_000 });
            await completed.promise;
          },
        }),
      };
      const result = withProofCall({ app: { open: async () => {} }, screen }, async () => {
        if (callbackLeave) await screen.getByRole("button", "Leave call").click();
      });
      const outcome = result.then(
        () => undefined,
        (error) => error,
      );
      try {
        await clicked.promise;
        await setImmediate();
        assert.equal(disposed, false);
      } finally {
        if (timeout) completed.reject(failure);
        else completed.resolve();
        assert.equal(await outcome, timeout ? failure : undefined);
      }
      assert.equal(disposed, true);
    });
});
