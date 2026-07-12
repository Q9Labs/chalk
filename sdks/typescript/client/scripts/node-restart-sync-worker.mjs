import { readFile, rename, writeFile } from "node:fs/promises";
import { createBrowserWebSocketFactory, createSyncClient } from "../dist/index.js";

const action = process.argv[2];
const url = requiredEnvironment("CHALK_SYNC_BROWSER_URL");
const token = requiredEnvironment("CHALK_SYNC_BROWSER_TOKEN");
const pendingStorePath = requiredEnvironment("CHALK_SYNC_PENDING_STORE_PATH");

async function run() {
  const client = createSyncClient({
    lifecycle: { subscribe: () => () => {} },
    pendingStore: new FilePendingCommandStore(pendingStorePath),
    token: async () => token,
    url,
    webSocket: createBrowserWebSocketFactory(globalThis.WebSocket),
  });

  try {
    if (action === "stage") {
      await stagePendingCommand(client);
      return;
    }
    if (action === "resume") {
      await resumePendingCommand(client);
      return;
    }
    throw new Error("worker action must be stage or resume");
  } finally {
    client.stop();
  }
}

async function stagePendingCommand(client) {
  await client.send({ name: "raise_hand" });
  const snapshot = client.getSnapshot();

  if (snapshot.pending.count !== 1) {
    throw new Error("first process did not retain the staged pending command");
  }

  process.stdout.write(JSON.stringify({ pending: snapshot.pending.count }) + "\n");
}

async function resumePendingCommand(client) {
  await client.start();
  const snapshot = await waitFor(() => {
    const next = client.getSnapshot();
    const participant = next.canonical?.state.participants[0];
    return next.pending.count === 0 && next.canonical?.revision === 2 && participant?.handRaised ? next : null;
  }, "restarted process did not converge the persisted command");

  process.stdout.write(JSON.stringify({ pending: snapshot.pending.count, revision: snapshot.canonical.revision }) + "\n");
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(description);
}

class FilePendingCommandStore {
  #path;

  constructor(path) {
    this.#path = path;
  }

  async load() {
    return copyCommands(await this.#read());
  }

  async put(command) {
    const commands = await this.#read();
    const next = [...commands.filter((candidate) => candidate.commandId !== command.commandId), copyCommand(command)];
    await this.#write(next);
  }

  async remove(commandId) {
    await this.#write((await this.#read()).filter((command) => command.commandId !== commandId));
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.#path, "utf8"));
      if (!Array.isArray(value)) {
        throw new TypeError("persistent pending command file is not an array");
      }
      return value;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async #write(commands) {
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(copyCommands(commands)) + "\n", "utf8");
    await rename(temporaryPath, this.#path);
  }
}

function copyCommands(commands) {
  return commands.map(copyCommand).sort((left, right) => left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId));
}

function copyCommand(command) {
  return {
    ...command,
    command: {
      ...command.command,
      ...(command.command.payload ? { payload: { ...command.command.payload } } : {}),
    },
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

await run();
