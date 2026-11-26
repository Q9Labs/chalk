import { expect, it } from "vitest";
import { dragHasFiles, routeChatFileDrop } from "./chat-file-drop";

it("routes file drops to chat whether the panel starts open or closed", () => {
  expect(routeChatFileDrop({ chatOpen: true, chatAvailable: true })).toBe("chat");
  expect(routeChatFileDrop({ chatOpen: false, chatAvailable: true })).toBe("chat");
});

it("has no file-drop target when chat is unavailable", () => {
  expect(routeChatFileDrop({ chatOpen: true, chatAvailable: false })).toBe("unavailable");
  expect(routeChatFileDrop({ chatOpen: false, chatAvailable: false })).toBe("unavailable");
});

it("recognizes only drags carrying files", () => {
  expect(dragHasFiles({ types: ["Files"] })).toBe(true);
  expect(dragHasFiles({ types: ["text/plain", "text/uri-list"] })).toBe(false);
  expect(dragHasFiles(null)).toBe(false);
});
