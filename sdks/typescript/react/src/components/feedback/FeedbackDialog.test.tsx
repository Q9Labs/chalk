// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../test-support/preview-client";
import { captureFeedbackScreenshot } from "../../utils/feedback";
import { FeedbackDialog } from "./FeedbackDialog";

vi.mock("../../utils/feedback", () => ({
  collectBrowserFeedbackEvidence: () => ({ sdk: { client: "test" }, platform: { kind: "web" } }),
  captureFeedbackScreenshot: vi.fn(),
}));

describe("Feedback without a screenshot", () => {
  it.each(["removed", "unavailable"] as const)("submits text when the screenshot is %s", async (state) => {
    vi.mocked(captureFeedbackScreenshot).mockResolvedValue(state === "removed" ? { state: "captured", mime_type: "image/png", width: 1, height: 1, captured_at: new Date().toISOString(), data_base64: "iVBORw0KGgo=" } : { state: "unavailable", failure_code: "unsupported" });
    const client = createPreviewClient();
    const prepare = client.feedback.prepare;
    const sent = vi.fn();
    vi.spyOn(client.feedback, "prepare").mockImplementation(async (input) => {
      const prepared = await prepare(input);
      return {
        ...prepared,
        send: async (submission) => {
          sent(submission, prepared.evidence.screenshot.state);
          return prepared.send(submission);
        },
      };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<FeedbackDialog isOpen onClose={() => undefined} client={client} captureRootRef={{ current: null }} />));
      if (state === "removed") {
        const remove = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove");
        expect(remove?.disabled).toBe(false);
        await act(async () => remove?.click());
      }
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("Feedback message input is missing");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "The image did not load.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const submit = container.querySelector('button[type="submit"]');
      if (!(submit instanceof HTMLButtonElement)) throw new Error("Feedback submit button is missing");
      expect(submit.disabled).toBe(false);
      await act(async () => submit.click());
      expect(sent).toHaveBeenCalledWith(expect.objectContaining({ message: "The image did not load." }), state);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.dispose();
      vi.restoreAllMocks();
    }
  });
});
