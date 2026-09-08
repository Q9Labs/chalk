import type { FeedbackCategory, FeedbackEvidenceInput, FeedbackPrepared, FeedbackSource, SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type React from "react";

import { Cancel01Icon, RefreshIcon } from "../../utils/icons";
import { captureFeedbackScreenshot, collectBrowserFeedbackEvidence } from "../../utils/feedback";
import { cn } from "../../utils/cn";
import { ChalkBackdrop, ChalkButton, ChalkDialogPanel, ChalkIconButton, ChalkTextarea } from "../chalk-ui";
import { useSkin } from "../skin-context";

export interface FeedbackDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly client: SpaceClient;
  readonly source?: FeedbackSource;
  readonly captureRootRef: RefObject<HTMLElement | null>;
}

const CATEGORIES: readonly { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature_request", label: "Feature request" },
  { value: "other", label: "Other" },
];

export function FeedbackDialog({ isOpen, onClose, client, source = "embedded", captureRootRef }: FeedbackDialogProps): React.JSX.Element | null {
  const skin = useSkin();
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [prepared, setPrepared] = useState<FeedbackPrepared | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | undefined>();
  const [screenshotFailure, setScreenshotFailure] = useState<string | undefined>();
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [prepareError, setPrepareError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const openedRef = useRef(false);

  const prepareFeedback = useCallback(
    async (includeScreenshot: boolean): Promise<void> => {
      setPreparing(true);
      setPrepareError(undefined);
      try {
        const evidence = collectBrowserFeedbackEvidence();
        const next = await client.feedback.prepare({
          source,
          evidence,
          screenshot_provider: () => (includeScreenshot ? captureFeedbackScreenshot(captureRootRef.current) : { state: "removed" }),
        });
        setPrepared(next);
        setScreenshotUrl(next.screenshot ? `data:${next.screenshot.mime_type};base64,${next.screenshot.data_base64}` : undefined);
        setScreenshotFailure(next.evidence.screenshot.state === "captured" || next.evidence.screenshot.state === "partial" ? undefined : next.evidence.screenshot.failure_code);
      } catch (cause) {
        setPrepared(null);
        setScreenshotUrl(undefined);
        setPrepareError(cause instanceof Error ? cause.message : "Feedback evidence is unavailable. You can still send this message.");
      } finally {
        setPreparing(false);
      }
    },
    [captureRootRef, client, source],
  );

  useEffect(() => {
    if (!isOpen) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    setCategory("bug");
    setMessage("");
    setPrepared(null);
    setScreenshotUrl(undefined);
    setScreenshotFailure(undefined);
    setPrepareError(undefined);
    setSubmitError(undefined);
    setSubmitted(false);
    void prepareFeedback(true);
  }, [isOpen, prepareFeedback]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const reviseFeedback = (): void => {
    if (!submitError) return;
    setSubmitError(undefined);
    setPrepared(null);
    void prepareFeedback(screenshotUrl !== undefined);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedMessage = message.trim();
    if (!normalizedMessage || submitting) return;
    setSubmitting(true);
    setSubmitError(undefined);
    const send = async () => {
      try {
        if (prepared) {
          await prepared.send({ category, message: normalizedMessage });
        } else {
          const evidence: FeedbackEvidenceInput = collectBrowserFeedbackEvidence();
          await client.feedback.send({ category, message: normalizedMessage, source, evidence: { ...evidence, screenshot: { state: "unavailable", failure_code: "capture_failed" } } });
        }
        setSubmitted(true);
      } catch (cause) {
        setSubmitError(cause instanceof Error ? cause.message : "Feedback could not be sent. Please try again.");
      } finally {
        setSubmitting(false);
      }
    };
    void send();
  };

  return (
    <div data-chalk-feedback-private data-chalk-skin={skin} className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <ChalkBackdrop className="z-0 !bg-[color-mix(in_srgb,var(--chalk-app-canvas)_90%,transparent)] !backdrop-blur-[1px]" />
      <div className="relative z-10 grid h-full place-items-center p-4">
        <ChalkDialogPanel
          className={cn("chalk-textured-surface w-full max-w-lg overflow-hidden !rounded-[14px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] !p-0 shadow-[var(--chalk-app-shadow-sm)]")}
          aria-modal="true"
          aria-labelledby="chalk-feedback-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-5 border-b border-[var(--chalk-app-line)] px-6 py-5">
            <div>
              <h2 id="chalk-feedback-title" className="text-xl font-semibold tracking-[-0.025em]">
                Send feedback
              </h2>
              <p className="mt-1 text-sm text-[var(--chalk-app-text-muted)]">Tell Chalk what happened. We’ll include safe technical context to help us understand it.</p>
            </div>
            <ChalkIconButton type="button" onClick={onClose} size="sm" aria-label="Close feedback dialog" className="!h-9 !w-9 !rounded-[8px] text-[var(--chalk-app-text-muted)]">
              <Cancel01Icon size={19} />
            </ChalkIconButton>
          </header>

          {submitted ? (
            <div className="space-y-5 p-6">
              <p role="status" className="text-sm leading-6 text-[var(--chalk-app-text)]">
                Thanks. Chalk received your feedback.
              </p>
              <ChalkButton type="button" variant="solid" tone="accent" className="w-full !text-[var(--chalk-app-control-active-text)]" onClick={onClose}>
                Done
              </ChalkButton>
            </div>
          ) : (
            <form className="space-y-5 p-6" onSubmit={submit}>
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">What kind of feedback is this?</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {CATEGORIES.map((option) => (
                    <label key={option.value} className={cn("flex cursor-pointer items-center gap-2 rounded-md border border-[var(--chalk-app-line)] px-3 py-2 text-sm", category === option.value && "border-[var(--chalk-app-control-active-line)] bg-[var(--chalk-app-control-active)]/10")}>
                      <input
                        type="radio"
                        name="feedback-category"
                        value={option.value}
                        checked={category === option.value}
                        onChange={() => {
                          setCategory(option.value);
                          reviseFeedback();
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block text-sm font-semibold" htmlFor="chalk-feedback-message">
                Message
                <ChalkTextarea
                  id="chalk-feedback-message"
                  className="mt-2"
                  required
                  maxLength={8_000}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    reviseFeedback();
                  }}
                  placeholder="What should we know?"
                  aria-describedby="chalk-feedback-message-help"
                />
              </label>
              <p id="chalk-feedback-message-help" className="text-xs text-[var(--chalk-app-text-muted)]">
                One message is enough. Please don’t include secrets or private content.
              </p>

              <div className="space-y-2" aria-live="polite">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">Screenshot</p>
                  <div className="flex gap-2">
                    <ChalkButton type="button" variant="outline" disabled={preparing} onClick={() => void prepareFeedback(true)} className="!h-8 !rounded-[7px] !px-2.5 !text-xs">
                      <RefreshIcon size={14} />
                      Refresh
                    </ChalkButton>
                    <ChalkButton type="button" variant="outline" disabled={preparing || !screenshotUrl} onClick={() => void prepareFeedback(false)} className="!h-8 !rounded-[7px] !px-2.5 !text-xs">
                      Remove
                    </ChalkButton>
                  </div>
                </div>
                {screenshotUrl ? (
                  <img src={screenshotUrl} alt="Screenshot preview" className="max-h-36 w-full rounded-md border border-[var(--chalk-app-line)] object-cover" />
                ) : (
                  <p className="rounded-md border border-dashed border-[var(--chalk-app-line)] px-3 py-3 text-xs text-[var(--chalk-app-text-muted)]">{preparing ? "Capturing a safe screenshot…" : screenshotFailure ? `Screenshot unavailable (${screenshotFailure}).` : "No screenshot attached."}</p>
                )}
              </div>

              {prepareError ? <p className="text-xs text-[var(--chalk-app-text-muted)]">{prepareError}</p> : null}
              {submitError ? (
                <p role="alert" className="text-sm text-[var(--chalk-app-danger)]">
                  {submitError}
                </p>
              ) : null}
              <ChalkButton type="submit" variant="solid" tone="accent" loading={submitting} disabled={preparing || !message.trim()} className="w-full !text-[var(--chalk-app-control-active-text)]">
                Send feedback
              </ChalkButton>
            </form>
          )}
        </ChalkDialogPanel>
      </div>
    </div>
  );
}
