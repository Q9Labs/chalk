export type ServerSentEvent = Readonly<{
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}>;

export const SERVER_SENT_EVENT_LIMITS = Object.freeze({
  maxPartialLineBytes: 64 * 1024,
  maxDataBytes: 128 * 1024,
  maxEventBytes: 256 * 1024,
});

export class ServerSentEventLimitError extends Error {
  constructor(readonly scope: "partial_line" | "data" | "event") {
    super(`The live stream exceeded its ${scope.replaceAll("_", " ")} safety limit`);
    this.name = "ServerSentEventLimitError";
  }
}

const toAsyncChunks = async function* (stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
};

export const decodeServerSentEvents = async function* (input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, onActivity?: () => void): AsyncGenerator<ServerSentEvent> {
  const chunks = Symbol.asyncIterator in input ? input : toAsyncChunks(input);
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];
  let eventBytes = 0;
  let dataBytes = 0;
  const encoder = new TextEncoder();

  const dispatch = (): ServerSentEvent | undefined => {
    if (data.length === 0) {
      event = undefined;
      retry = undefined;
      eventBytes = 0;
      dataBytes = 0;
      return undefined;
    }
    const message = {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      data: data.join("\n"),
      ...(retry === undefined ? {} : { retry }),
    };
    data = [];
    event = undefined;
    retry = undefined;
    eventBytes = 0;
    dataBytes = 0;
    return message;
  };

  const readLine = (line: string): ServerSentEvent | undefined => {
    eventBytes += encoder.encode(line).byteLength;
    if (eventBytes > SERVER_SENT_EVENT_LIMITS.maxEventBytes) throw new ServerSentEventLimitError("event");
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataBytes += encoder.encode(value).byteLength + (data.length > 0 ? 1 : 0);
      if (dataBytes > SERVER_SENT_EVENT_LIMITS.maxDataBytes) throw new ServerSentEventLimitError("data");
      data.push(value);
    }
    if (field === "event") event = value;
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    return undefined;
  };

  for await (const chunk of chunks) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const lineEnd = buffer.search(/\r?\n/);
      if (lineEnd === -1) break;
      const newlineLength = buffer[lineEnd] === "\r" ? 2 : 1;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + newlineLength);
      if (encoder.encode(line).byteLength > SERVER_SENT_EVENT_LIMITS.maxPartialLineBytes) throw new ServerSentEventLimitError("partial_line");
      const message = readLine(line);
      if (message) yield message;
    }
    if (encoder.encode(buffer).byteLength > SERVER_SENT_EVENT_LIMITS.maxPartialLineBytes) throw new ServerSentEventLimitError("partial_line");
  }

  buffer += decoder.decode();
  if (encoder.encode(buffer).byteLength > SERVER_SENT_EVENT_LIMITS.maxPartialLineBytes) throw new ServerSentEventLimitError("partial_line");
  if (buffer.length > 0) {
    const message = readLine(buffer.replace(/\r$/, ""));
    if (message) yield message;
  }
  const finalMessage = dispatch();
  if (finalMessage) yield finalMessage;
};
