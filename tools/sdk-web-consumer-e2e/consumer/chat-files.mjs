import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";

export function createChatFileRoutes({ readJSON, sendJSON, send }) {
  let attachment;
  let expectedDigest;
  let uploadedBytes;
  const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
  const fileURL = (request) => `http://${request.headers.host}/test/chat-file`;

  return new Map([
    [
      "POST /v1/chat/attachments/uploads",
      async (request, response) => {
        const input = await readJSON(request);
        attachment = { attachmentId: "fixture-attachment", fileName: input.fileName, mimeType: input.mimeType, byteLength: input.byteLength };
        expectedDigest = input.sha256;
        uploadedBytes = undefined;
        sendJSON(response, 200, { attachmentId: attachment.attachmentId, uploadId: "fixture-upload", method: "PUT", uploadUrl: fileURL(request), headers: { "content-type": attachment.mimeType }, expiresAt: expiresAt() });
      },
    ],
    [
      "PUT /test/chat-file",
      async (request, response) => {
        const bytes = await buffer(request);
        if (!attachment || bytes.byteLength !== attachment.byteLength || createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
          return sendJSON(response, 400, { error: "file_contents_mismatch" });
        }
        uploadedBytes = bytes;
        send(response, 200, "", "text/plain");
      },
    ],
    [
      "POST /v1/chat/attachments/uploads/fixture-upload/finalize",
      (_request, response) => {
        if (!uploadedBytes) return sendJSON(response, 409, { error: "upload_missing" });
        sendJSON(response, 200, attachment);
      },
    ],
    [
      "GET /v1/chat/attachments/fixture-attachment/download",
      (request, response) => {
        if (!uploadedBytes) return sendJSON(response, 404, { error: "file_missing" });
        sendJSON(response, 200, { downloadUrl: fileURL(request), expiresAt: expiresAt() });
      },
    ],
    [
      "GET /test/chat-file",
      (_request, response) => {
        if (!uploadedBytes) return sendJSON(response, 404, { error: "file_missing" });
        send(response, 200, uploadedBytes, attachment.mimeType);
      },
    ],
  ]);
}
