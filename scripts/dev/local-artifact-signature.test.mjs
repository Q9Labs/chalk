import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { isLocalArtifactRequestSigned, rfc3986 } from "../../apps/web/scripts/local-artifact-signature.mjs";
import { LOCAL_ARTIFACT_ACCESS_KEY_ID, LOCAL_ARTIFACT_SECRET_ACCESS_KEY } from "./dashboard-artifacts.mjs";

const host = "127.0.0.1:3070";
const amzDate = "20261126T120000Z";
const day = "20261126";
const credentials = { accessKeyId: LOCAL_ARTIFACT_ACCESS_KEY_ID, secretAccessKey: LOCAL_ARTIFACT_SECRET_ACCESS_KEY, now: Date.parse("2026-11-26T12:01:00Z") };

// An independent signer for the test: the SigV4 rules written out in the order the spec lists them.
function sign({ method, path, query = {}, headers = {}, secret = LOCAL_ARTIFACT_SECRET_ACCESS_KEY, signedOnly }) {
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const everyHeader = { host, "x-amz-date": amzDate, ...headers };
  const allHeaders = signedOnly ? Object.fromEntries(Object.entries(everyHeader).filter(([name]) => signedOnly.includes(name))) : everyHeader;
  const names = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [rfc3986(name), rfc3986(value)])
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [method, path, canonicalQuery, names.map((name) => `${name}:${allHeaders[name]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const key = ["us-east-1", "s3", "aws4_request"].reduce((k, part) => createHmac("sha256", k).update(part).digest(), createHmac("sha256", `AWS4${secret}`).update(day).digest());
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return { signature, scope, names, allHeaders };
}

function headerSigned(method, path, headers = {}, secret) {
  const { signature, scope, names, allHeaders } = sign({ method, path, headers, secret });
  const authorization = `AWS4-HMAC-SHA256 Credential=${LOCAL_ARTIFACT_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  const { host: _host, ...sent } = allHeaders;
  return { method, url: path, headers: { host, authorization, ...sent, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } };
}

function presigned(method, path, expires = 900) {
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${LOCAL_ARTIFACT_ACCESS_KEY_ID}/${day}/us-east-1/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const { signature } = sign({ method, path, query, signedOnly: ["host"] });
  const search = Object.entries({ ...query, "X-Amz-Signature": signature })
    .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
    .join("&");
  return { method, url: `${path}?${search}`, headers: { host } };
}

const path = "/__local-dashboard-artifacts/local-dashboard/chat/file%20one.pdf";

test("a header-signed write with the local storage credential is accepted", () => {
  assert.equal(isLocalArtifactRequestSigned(headerSigned("PUT", path, { "content-type": "application/pdf" }), credentials), true);
});

test("a presigned upload URL is accepted until it expires", () => {
  assert.equal(isLocalArtifactRequestSigned(presigned("PUT", path), credentials), true);
  assert.equal(isLocalArtifactRequestSigned(presigned("PUT", path), { ...credentials, now: Date.parse("2026-11-26T12:30:00Z") }), false);
});

test("an unsigned or wrongly signed write is refused", () => {
  assert.equal(isLocalArtifactRequestSigned({ method: "PUT", url: path, headers: { host } }, credentials), false);
  assert.equal(isLocalArtifactRequestSigned({ method: "DELETE", url: path, headers: { host } }, credentials), false);
  assert.equal(isLocalArtifactRequestSigned(headerSigned("PUT", path, {}, "not-the-secret"), credentials), false);
});

test("a signature does not carry over to another method or object", () => {
  const signed = headerSigned("PUT", path, {});
  assert.equal(isLocalArtifactRequestSigned({ ...signed, method: "DELETE" }, credentials), false);
  assert.equal(isLocalArtifactRequestSigned({ ...signed, url: "/__local-dashboard-artifacts/local-dashboard/other.pdf" }, credentials), false);
});
