import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDevConfig } from "./config.mjs";
import { createResourceManager } from "./chalk-resources.mjs";
import { runCommand } from "./commands.mjs";

test("reset approval lists exactly the slot Postgres and Redis resources that reset touches", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-dev-reset-"));
  try {
    const config = resolveDevConfig({
      root,
      requiredTools: [],
      env: {
        CHALK_POSTGRES_CONTAINER: "chalk-postgres-slot-1-token",
        CHALK_POSTGRES_VOLUME: "chalk-postgres-slot-1-token-volume",
        CHALK_REDIS_CONTAINER: "chalk-slot-1-token",
        CHALK_REDIS_VOLUME: "chalk-slot-1-token-volume",
        CHALK_DEV_STATE_ROOT: join(root, "state"),
      },
    });
    const touched = { containers: new Set(), volumes: new Set(), databases: new Set() };
    const manager = createResourceManager(config, {
      docker: async (name) => {
        touched.containers.add(name);
        return undefined;
      },
      runner: async (command, args, options) => {
        const env = options.env || {};
        for (const name of [env.CHALK_POSTGRES_CONTAINER, env.CHALK_REDIS_CONTAINER]) if (name) touched.containers.add(name);
        for (const name of [env.CHALK_POSTGRES_VOLUME, env.CHALK_REDIS_VOLUME]) if (name) touched.volumes.add(name);
        if (command === "docker" && args[0] === "exec") {
          touched.containers.add(args[1]);
          touched.databases.add(`${args[1]}/${args.at(-1).match(/"([^"]+)"/)[1]}`);
        }
        return { stdout: "" };
      },
    });
    const { targets } = await runCommand("reset", config, { yes: true, hooks: { resetResources: () => manager.reset() }, output: () => {} });
    assert.deepEqual([...touched.containers].sort(), [...new Set([...targets.containers, ...targets.preservedContainers])].sort());
    assert.deepEqual([...touched.volumes].sort(), [...targets.volumes, ...targets.preservedVolumes].sort());
    assert.deepEqual(
      [...touched.databases],
      targets.databases.map(({ container, name }) => `${container}/${name}`),
    );
    assert.ok(!JSON.stringify(targets).includes('"chalk-postgres"'), "a slot reset must not name the shared Postgres");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slot dev startup, SQL, reset and cleanup use their own Postgres container", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-dev-slot-"));
  try {
    for (const slot of [0, 1]) {
      const container = `chalk-postgres-slot-${slot}-test`;
      const volume = `${container}-volume`;
      const config = resolveDevConfig({
        root,
        requiredTools: [],
        env: {
          CHALK_POSTGRES_CONTAINER: container,
          CHALK_POSTGRES_VOLUME: volume,
          CHALK_DEV_POSTGRES_PORT: String(21004 + slot * 100),
          CHALK_DEV_STATE_ROOT: join(root, `state-${slot}`),
        },
      });
      const commands = [];
      let running = false;
      const identityStop = new Error("stop before identity generation");
      const manager = createResourceManager(config, {
        docker: async (name) => {
          assert.notEqual(name, "chalk-postgres", "slot must never inspect the shared legacy Postgres");
          return name === container && running ? { running: true, hostPorts: [config.ports.postgres] } : undefined;
        },
        runner: async (command, args, options) => {
          commands.push({ command, args, options });
          if (command === "docker") assert.equal(args[1], container);
          if (args[0]?.endsWith("dev-postgres.sh")) {
            assert.equal(options.env.CHALK_POSTGRES_CONTAINER, container);
            if (args[1] === "start") {
              assert.equal(options.env.CHALK_POSTGRES_VOLUME, volume);
              running = true;
            }
          }
          return { stdout: "" };
        },
        identityGenerator: async () => {
          throw identityStop;
        },
      });
      await manager.preflight({ probe: async () => ({ available: true }) });
      await assert.rejects(manager.start(), identityStop);
      await manager.reset();
      await manager.stop();
      assert.ok(commands.some(({ args }) => args[0]?.endsWith("dev-postgres.sh") && args[1] === "stop"));
      assert.ok(commands.some(({ command, args }) => command === "docker" && args.at(-1).startsWith("DROP DATABASE")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
