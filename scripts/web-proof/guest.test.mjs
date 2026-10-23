import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

  for (const failures of [[], ["assertion"], ["assertion", "web-leave"], ["assertion", "sdk-leave"], ["assertion", "web-leave", "sdk-leave", "browser-close"], ["web-leave", "browser-close"]]) {
    await t.test(failures.join(" + ") || "successful call", async () => {
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
        getByRole: (_role, name) => ({ count: async () => 1, click: name === "Leave call" ? step("web-leave") : async () => {} }),
      };
      const result = withProofCall({ app: { open: async () => {} }, screen }, step("assertion"));
      if (!failures.length) await result;
      else {
        await assert.rejects(result, (error) => {
          const flatten = (entry) => (entry instanceof AggregateError ? entry.errors.flatMap(flatten) : [entry]);
          assert.deepEqual(flatten(error), [...errors.values()]);
          if (failures.length === 1) assert.equal(error, errors.values().next().value);
          return true;
        });
      }
      assert.deepEqual(calls, ["assertion", "web-leave", "sdk-leave", "browser-close"]);
    });
  }
});
