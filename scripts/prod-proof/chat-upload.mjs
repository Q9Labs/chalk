import { createHash, randomUUID } from "node:crypto";
import { openEpisode, prepareIntegration } from "./proofs.mjs";
import { fileURLToPath } from "node:url";
import { connect, loadSdk } from "./off-reason.mjs";
import { check, measured, save } from "./runtime.mjs";

// A browser origin that is on no list. The bucket's CORS rule must answer it anyway: the presigned
// signature is the access control, so a new tenant or portal origin never needs a bucket change.
const unlistedOrigin = "https://chat-upload-proof.invalid";
const body = new TextEncoder().encode(`chat upload proof ${randomUUID()}`);

async function chatApi(run, method, path, token, payload) {
  const response = await fetch(new URL(path, run.config.api_url), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "Chalk-Production-Proof/1.0" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.any([AbortSignal.timeout(30_000), run.signal]),
  });
  const value = await response.json().catch(() => ({}));
  // Report the error code only: messages and URLs can carry production identifiers.
  check(response.ok, `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} answered HTTP ${response.status} (${value.error?.code ?? value.code ?? "no error code"})`, "chat-upload-api");
  return value;
}

// The message is public: show a CORS header only when it is plain header syntax, never free text.
function headerValue(value) {
  if (value === null) return "absent";
  return /^[\w*,:/. -]{0,200}$/.test(value) ? value : "unexpected";
}

export function corsRefusal(step, response, detail) {
  const seen = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"].map((name) => `${name}=${headerValue(response.headers.get(name))}`).join(" ");
  return `Chat upload ${step} from an origin on no list failed (${detail}; HTTP ${response.status}; ${seen}). The storage bucket's CORS rule does not allow every origin: browsers will block chat and whiteboard uploads. Restore the rule from infrastructure/recorder/main.tf.`;
}

export function allows(header, wanted) {
  const listed = (header ?? "").split(",").map((value) => value.trim().toLowerCase());
  return listed.includes("*") || wanted.every((name) => listed.includes(name));
}

// The any-origin CORS rule is safe only while the bucket is private: a request with no signature must be refused.
export function unsigned(url) {
  const bare = new URL(url);
  bare.search = "";
  return bare.toString();
}

export function refusedWithoutSignature(status) {
  return [400, 401, 403, 404].includes(status);
}

function allowsOrigin(response) {
  return ["*", unlistedOrigin].includes(response.headers.get("access-control-allow-origin") ?? "");
}

// Chat is open only to an active Participant, and a Participant is active once its Sync socket is live.
async function admitAndConnect(run, path, clients) {
  const admission = await run.apiRequest("POST", `${path}/participants`, { name: "Proof uploader", role: "owner" });
  const token = admission.access.sync.token;
  const sdk = await loadSdk(run, "chat-upload", fileURLToPath(new URL("../../sdks/typescript/client/src/index.ts", import.meta.url)));
  const { defaultSyncUrl } = await loadSdk(run, "chat-upload-urls", fileURLToPath(new URL("../../sdks/typescript/client/src/space-client/urls.ts", import.meta.url)));
  await connect(run, clients, sdk, defaultSyncUrl(run.config.api_url), token);
  return token;
}

export async function chatUploadProof(run) {
  await prepareIntegration(run, false);
  const { path, ending } = await openEpisode(run);
  const clients = [];
  try {
    const token = await admitAndConnect(run, path, clients);
    const upload = await chatApi(run, "POST", "/v1/chat/attachments/uploads", token, {
      clientAttachmentId: randomUUID(),
      fileName: "cors-proof.txt",
      mimeType: "text/plain",
      byteLength: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    // A browser cannot set Host and sends the other signed header names in the preflight.
    const headers = Object.fromEntries(Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== "host"));
    const wanted = Object.keys(headers).map((name) => name.toLowerCase());
    const timeout = () => AbortSignal.any([AbortSignal.timeout(30_000), run.signal]);

    const preflight = await fetch(upload.uploadUrl, {
      method: "OPTIONS",
      headers: { Origin: unlistedOrigin, "Access-Control-Request-Method": upload.method, "Access-Control-Request-Headers": [...wanted].sort().join(",") },
      signal: timeout(),
    });
    const methods = (preflight.headers.get("access-control-allow-methods") ?? "")
      .toUpperCase()
      .split(",")
      .map((value) => value.trim());
    measured(preflight.status < 300 && allowsOrigin(preflight), corsRefusal("preflight", preflight, "origin refused"));
    measured(methods.includes(upload.method), corsRefusal("preflight", preflight, `${upload.method} not allowed`));
    measured(allows(preflight.headers.get("access-control-allow-headers"), wanted), corsRefusal("preflight", preflight, "a signed header is not allowed"));

    const put = await fetch(upload.uploadUrl, { method: upload.method, headers: { ...headers, Origin: unlistedOrigin }, body, signal: timeout() });
    measured(put.ok, corsRefusal("PUT", put, "storage rejected the signed request"));
    measured(allowsOrigin(put), corsRefusal("PUT", put, "response carries no allow-origin"));

    const attachment = await chatApi(run, "POST", `/v1/chat/attachments/uploads/${upload.uploadId}/finalize`, token);
    const download = await chatApi(run, "GET", `/v1/chat/attachments/${attachment.attachmentId}/download`, token);
    const read = await fetch(download.downloadUrl, { headers: { Origin: unlistedOrigin }, signal: timeout() });
    measured(read.ok && allowsOrigin(read), corsRefusal("download", read, "the signed GET was refused"));
    measured(Buffer.from(await read.arrayBuffer()).equals(Buffer.from(body)), "Chat upload download returned different bytes than the upload");
    const anonymous = await fetch(unsigned(upload.uploadUrl), { signal: timeout() });
    measured(refusedWithoutSignature(anonymous.status), `The uploaded chat object can be read without a signature (HTTP ${anonymous.status}). The any-origin CORS rule is only safe on a private bucket: turn off public access and remove custom domains before anything else.`);
    const result = { preflight: preflight.status, put: put.status, download: read.status, unsigned: anonymous.status, origin: unlistedOrigin };
    await save(`${run.directory}/chat-upload.json`, result);
    return result;
  } finally {
    for (const client of clients) client.stop();
    await ending.end();
  }
}
