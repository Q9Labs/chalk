import { expect, test } from "vitest";
import { artifactObjectHeaders, artifactWriteAllowed } from "./local-dashboard.mjs";

test("uploaded artifacts cannot execute active content on the dashboard origin", () => {
  const headers = artifactObjectHeaders("/local-dashboard/evil.html", Buffer.from("<script>alert(1)</script>"), { contentType: "text/html" });
  expect(headers["Content-Type"]).toBe("text/html");
  expect(headers["Content-Disposition"]).toBe("attachment");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
});

test("artifact writes and deletes are limited to loopback clients", () => {
  expect(artifactWriteAllowed("127.0.0.1")).toBe(true);
  expect(artifactWriteAllowed("::1")).toBe(true);
  expect(artifactWriteAllowed("::ffff:127.0.0.1")).toBe(true);
  expect(artifactWriteAllowed("192.0.2.10")).toBe(false);
  expect(artifactWriteAllowed(undefined)).toBe(false);
});
