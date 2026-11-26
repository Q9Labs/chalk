import { expect, test } from "vitest";
import { artifactObjectHeaders, artifactSignatureValid } from "./local-dashboard.mjs";

test("uploaded artifacts cannot execute active content on the dashboard origin", () => {
  const headers = artifactObjectHeaders("/local-dashboard/evil.html", Buffer.from("<script>alert(1)</script>"), { contentType: "text/html" });
  expect(headers["Content-Type"]).toBe("text/html");
  expect(headers["Content-Disposition"]).toBe("attachment");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
});

test("artifact writes and deletes require a valid unexpired signed URL", () => {
  const signed = new URL("http://localhost:3070/__local-dashboard-artifacts/local-dashboard/test.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=local-dashboard%2F20261126%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261126T043237Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&x-id=PutObject&X-Amz-Signature=93c225d94274f83d9a89ed47fce28250b56ba51a6a7c813a80880b3945d69b6a");
  const now = new Date("2026-11-26T04:33:00Z");
  const incoming = { headers: { host: "localhost:3070" } };
  expect(artifactSignatureValid("PUT", signed, incoming, now)).toBe(true);
  expect(artifactSignatureValid("DELETE", signed, incoming, now)).toBe(false);
  const signedDelete = new URL("http://localhost:3070/__local-dashboard-artifacts/local-dashboard/test.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=local-dashboard%2F20261126%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261126T045504Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&x-id=DeleteObject&X-Amz-Signature=313cbcce97871ac19a59bf6ba2db2f7e9bdf577e30f0ba7700a02d4ee8955f90");
  expect(artifactSignatureValid("DELETE", signedDelete, incoming, new Date("2026-11-26T04:56:00Z"))).toBe(true);
  expect(artifactSignatureValid("PUT", signedDelete, incoming, new Date("2026-11-26T04:56:00Z"))).toBe(false);
  expect(artifactSignatureValid("PUT", signed, { headers: { host: "evil.test" } }, now)).toBe(false);
  expect(artifactSignatureValid("PUT", signed, incoming, new Date("2026-11-26T05:33:00Z"))).toBe(false);
  const unsigned = new URL("http://localhost:3070/__local-dashboard-artifacts/local-dashboard/test.pdf");
  expect(artifactSignatureValid("PUT", unsigned, incoming, now)).toBe(false);
});
