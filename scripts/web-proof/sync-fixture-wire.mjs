import { createHash } from "node:crypto";

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = payload.length < 126 ? payload.length : 126;
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

// Browser frames are masked. Leave partial/coalesced frames buffered; these
// small JSON fixtures never use RFC6455's 64-bit payload-length form.
function decodeFrame(buffer) {
  if (buffer.length < 6) return null;
  const lengthCode = buffer[1] & 127;
  if (lengthCode === 127) return null;
  const offset = lengthCode === 126 ? 4 : 2;
  return decodePayload(buffer, offset, lengthCode);
}

function decodePayload(buffer, offset, lengthCode) {
  if (buffer.length < offset + 4) return null;
  const length = lengthCode === 126 ? buffer.readUInt16BE(2) : lengthCode;
  const end = offset + 4 + length;
  if (buffer.length < end) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = buffer.subarray(offset + 4, end).map((byte, index) => byte ^ mask[index % 4]);
  return { opcode: buffer[0] & 15, payload, rest: buffer.subarray(end) };
}

function sendSnapshot(socket, frames) {
  for (const item of frames()) socket.write(encodeFrame(item));
}

function receiveMessage(socket, message, frames) {
  if (message.type === "hello") sendSnapshot(socket, frames);
  if (message.type === "entered") socket.write(encodeFrame({ type: "entered_ack" }));
  if (message.type === "ping") socket.write(encodeFrame({ type: "pong" }));
}

function receiveFrame(socket, frame, frames) {
  if (frame.opcode === 8) {
    socket.end();
    return false;
  }
  if (frame.opcode === 1) receiveMessage(socket, JSON.parse(frame.payload.toString()), frames);
  return true;
}

export function acceptFixtureSocket(request, socket, frames) {
  const accept = createHash("sha1")
    .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let frame = decodeFrame(buffered);
    while (frame) {
      buffered = frame.rest;
      if (!receiveFrame(socket, frame, frames)) return;
      frame = decodeFrame(buffered);
    }
  });
}

export function trackFixtureSockets(server, sockets) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
}
