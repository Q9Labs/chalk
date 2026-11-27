import { expect, it } from "vitest";
import { formatFileSize } from "./use-chat-attachment-previews";

it("shows chat file sizes over 1 MB in MB", () => {
  expect(formatFileSize(1)).toBe("1 KB");
  expect(formatFileSize(512 * 1024)).toBe("512 KB");
  expect(formatFileSize(1024 * 1024)).toBe("1 MB");
  expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
});
