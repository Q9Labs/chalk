import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Checks AWS Signature Version 4 on a local artifact request, header-signed (the API's own client) or presigned (the
// browser's upload URL), the way R2 does. Anything it cannot parse is refused, so a malformed request never passes.

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const HEADER_AUTH = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/;

export function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(time) ? null : { time, date: `${year}${month}${day}` };
}

function canonicalPath(pathname) {
  return pathname
    .split("/")
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join("/");
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function canonicalQuery(searchParams) {
  return [...searchParams]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [rfc3986(name), rfc3986(value)])
    .sort(([nameA, valueA], [nameB, valueB]) => compareText(nameA, nameB) || compareText(valueA, valueB))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** Reads the signing fields from a presigned query or from the Authorization header. */
function signingFields(request, url) {
  if (url.searchParams.has("X-Amz-Signature")) {
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    return {
      algorithm: url.searchParams.get("X-Amz-Algorithm"),
      credential: url.searchParams.get("X-Amz-Credential"),
      amzDate: url.searchParams.get("X-Amz-Date"),
      signedHeaders: url.searchParams.get("X-Amz-SignedHeaders"),
      signature: url.searchParams.get("X-Amz-Signature"),
      expires,
      payloadHash: request.headers["x-amz-content-sha256"] ?? UNSIGNED_PAYLOAD,
    };
  }
  const match = HEADER_AUTH.exec(request.headers.authorization ?? "");
  if (!match) return null;
  return {
    algorithm: ALGORITHM,
    credential: match[1],
    amzDate: request.headers["x-amz-date"],
    signedHeaders: match[2],
    signature: match[3],
    expires: null,
    payloadHash: request.headers["x-amz-content-sha256"] ?? UNSIGNED_PAYLOAD,
  };
}

function timeIsValid(fields, amz, now) {
  if (fields.expires === null) return Math.abs(now - amz.time) <= MAX_CLOCK_SKEW_MS;
  if (!Number.isInteger(fields.expires) || fields.expires < 1 || fields.expires > MAX_PRESIGN_SECONDS) return false;
  return now >= amz.time - MAX_CLOCK_SKEW_MS && now <= amz.time + fields.expires * 1000;
}

/**
 * True when the request is signed with the local storage credential and the signature covers the request as sent.
 * `now` is injectable so tests can check expiry.
 */
export function isLocalArtifactRequestSigned(request, { accessKeyId, secretAccessKey, now = Date.now() }) {
  try {
    const url = new URL(request.url, "http://localhost");
    const fields = signingFields(request, url);
    if (!fields || fields.algorithm !== ALGORITHM) return false;
    const [key, date, region, service, terminator] = fields.credential.split("/");
    const amz = parseAmzDate(fields.amzDate);
    if (!amz || key !== accessKeyId || date !== amz.date || service !== "s3" || terminator !== "aws4_request") return false;
    if (!timeIsValid(fields, amz, now)) return false;

    const names = fields.signedHeaders.split(";").map((name) => name.toLowerCase());
    if (!names.includes("host")) return false;
    const headerLines = names.map((name) => {
      const value = request.headers[name];
      if (value === undefined) throw new Error(`Missing signed header ${name}`);
      return `${name}:${String(value).trim().replace(/\s+/g, " ")}\n`;
    });
    const canonicalRequest = [request.method, canonicalPath(url.pathname), canonicalQuery(url.searchParams), headerLines.join(""), names.join(";"), fields.payloadHash].join("\n");
    const scope = `${amz.date}/${region}/s3/aws4_request`;
    const stringToSign = [ALGORITHM, fields.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = [region, "s3", "aws4_request"].reduce((key, part) => hmac(key, part), hmac(`AWS4${secretAccessKey}`, amz.date));
    const expected = Buffer.from(hmac(signingKey, stringToSign).toString("hex"));
    const actual = Buffer.from(fields.signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
