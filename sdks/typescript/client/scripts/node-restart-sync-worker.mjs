import { readFile, rename, writeFile } from "node:fs/promises";
import { createV3SyncClient } from "../dist/index.js";

const action = process.argv[2];
const url = requiredEnvironment("CHALK_SYNC_BROWSER_URL");
const token = requiredEnvironment("CHALK_SYNC_BROWSER_TOKEN");
const pendingStorePath = requiredEnvironment("CHALK_SYNC_PENDING_STORE_PATH");

async function run() {
  const client = createV3SyncClient({
    lifecycle: { subscribe: () => () => {} },
    pendingStore: new FilePendingCommandStore(pendingStorePath),
    token: async () => token,
    url,
    webSocket: createNodeWebSocketFactory(),
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

function createNodeWebSocketFactory() {
  return { connect: (socketUrl) => new NodeSyncSocket(socketUrl) };
}

class NodeSyncSocket {
  #socket;
  #receivedFrameTypes = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor(socketUrl) {
    this.#socket = new WebSocket(socketUrl);
    this.#socket.addEventListener("open", () => this.onopen?.());
    this.#socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(event.data);
        this.#receivedFrameTypes.push([frame.type, frame.code, frame.outcome, frame.revision].filter((value) => value !== undefined).join(":"));
      } catch {
        this.#receivedFrameTypes.push(typeof event.data);
      }
      if (this.#receivedFrameTypes.length > 12) this.#receivedFrameTypes.shift();
      this.onmessage?.({ data: event.data });
    });
    this.#socket.addEventListener("close", (event) => this.onclose?.({ code: event.code }));
    this.#socket.addEventListener("error", () => this.onerror?.());
  }

  send(data) {
    this.#socket.send(data);
  }

  close(code, reason) {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`v3 client requested invalid browser close code ${code} (${reason ?? "no reason"}); recent frames=${this.#receivedFrameTypes.join(",")}`);
    }
    this.#socket.close(code, reason);
  }
}

async function stagePendingCommand(client) {
  void client.setHandRaised(true);
  const snapshot = await waitFor(() => (client.getSnapshot().pendingCommandCount === 1 ? client.getSnapshot() : null), "first process did not retain the staged v3 pending target");

  process.stdout.write(JSON.stringify({ pending: snapshot.pendingCommandCount }) + "\n");
  await new Promise(() => setInterval(() => {}, 60_000));
}

async function resumePendingCommand(client) {
  await client.start();
  const snapshot = await waitFor(() => {
    const next = client.getSnapshot();
    const participant = next.control?.participants.find((item) => item.participantSessionId === next.participantSessionId);
    return next.connection.phase === "live" && next.media && next.presence && next.pendingCommandCount === 0 && next.control?.revision === 2 && participant?.handRaised ? next : null;
  }, "restarted process did not converge the persisted command");

  process.stdout.write(JSON.stringify({ pending: snapshot.pendingCommandCount, revision: snapshot.control.revision }) + "\n");
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
