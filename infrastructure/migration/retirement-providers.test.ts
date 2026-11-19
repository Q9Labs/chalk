import assert from "node:assert/strict";
import { test } from "node:test";
import { removeDownloadGrant } from "./retirement-providers.ts";

test("retirement removes only the recorder runtime grant, preserves TLS denial and is idempotent", () => {
  const tls = { Sid: "DenyInsecureTransport", Effect: "Deny", Principal: "*", Action: "s3:*" };
  const unrelated = { Sid: "Unrelated", Effect: "Allow", Action: "s3:ListBucket" };
  const before = { Version: "2012-10-17", Statement: [tls, { Sid: "AllowRecorderArchiveCloudFront", Effect: "Allow" }, unrelated] };
  const after = removeDownloadGrant(before);
  assert.deepEqual(after, { Version: "2012-10-17", Statement: [tls, unrelated] });
  assert.deepEqual(removeDownloadGrant(after), after);
  assert.equal(before.Statement.length, 3);
});
