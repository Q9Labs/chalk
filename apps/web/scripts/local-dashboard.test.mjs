import { expect, test } from "vitest";
import { artifactObjectHeaders } from "./local-dashboard.mjs";

test("uploaded artifacts cannot execute active content on the dashboard origin", () => {
  const headers = artifactObjectHeaders("/local-dashboard/evil.html", Buffer.from("<script>alert(1)</script>"), { contentType: "text/html" });
  expect(headers["Content-Type"]).toBe("text/html");
  expect(headers["Content-Disposition"]).toBe("attachment");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
});
