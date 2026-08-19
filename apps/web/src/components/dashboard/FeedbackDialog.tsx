import { FEEDBACK_REQUEST_SCHEMA_VERSION, collectFeedbackEvidence, type FeedbackCategory, type FeedbackReportRequestV1, type FeedbackScreenshotCapture } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type React from "react";
import { captureFeedbackScreenshot, collectBrowserFeedbackEvidence, type FeedbackScreenshotResult } from "@q9labsai/chalk-react/utils";
import { submitFeedbackReport } from "../../lib/dashboard-api";
import { useWebTelemetry } from "../../lib/web-telemetry-context";
import { SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, SpaceDialogHeading, useModalDialog } from "./SpaceDialogPrimitives";

type DashboardFeedbackDialogProps = {
  open: boolean;
  tenantID: string;
  captureRootRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

const CATEGORIES: readonly { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature_request", label: "Feature request" },
  { value: "other", label: "Other" },
];

export function DashboardFeedbackDialog({ open, tenantID, captureRootRef, onClose }: DashboardFeedbackDialogProps) {
  const { journey } = useWebTelemetry();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [screenshot, setScreenshot] = useState<FeedbackScreenshotResult>({ state: "unavailable", failure_code: "unsupported" });
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const idempotencyKeyRef = useRef(createIdempotencyKey());
  const requestRef = useRef<FeedbackReportRequestV1 | null>(null);
  const captureGenerationRef = useRef(0);
  const previousTenantRef = useRef(tenantID);
  const previousOpenRef = useRef(open);

  const invalidateRequest = useCallback(() => {
    requestRef.current = null;
    idempotencyKeyRef.current = createIdempotencyKey();
  }, []);

  const capture = useCallback(async () => {
    const generation = ++captureGenerationRef.current;
    invalidateRequest();
    setScreenshot({ state: "unavailable", failure_code: "capture_failed" });
    setCapturing(true);
    setError(null);
    const result = await captureFeedbackScreenshot(captureRootRef.current);
    if (generation !== captureGenerationRef.current) return;
    setScreenshot(result);
    setCapturing(false);
  }, [captureRootRef, invalidateRequest]);

  const beginFeedback = useCallback(() => {
    captureGenerationRef.current += 1;
    setCategory("bug");
    setMessage("");
    setScreenshot({ state: "unavailable", failure_code: "capture_failed" });
    setSubmitted(false);
    setSending(false);
    setError(null);
    invalidateRequest();
    void capture();
  }, [capture, invalidateRequest]);

  useModalDialog(dialogRef, open, beginFeedback);

  useEffect(() => {
    if (previousTenantRef.current === tenantID) return;
    previousTenantRef.current = tenantID;
    if (open && previousOpenRef.current) {
      beginFeedback();
      return;
    }
    if (!open) {
      captureGenerationRef.current += 1;
      invalidateRequest();
      setScreenshot({ state: "unavailable", failure_code: "capture_failed" });
    }
  }, [beginFeedback, invalidateRequest, open, tenantID]);

  useEffect(() => {
    previousOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedMessage = message.trim();
    if (!normalizedMessage || sending || capturing) return;
    setSending(true);
    setError(null);
    try {
      const request = requestRef.current ?? feedbackRequest(category, normalizedMessage, screenshot, journey.context);
      requestRef.current = request;
      await submitFeedbackReport(tenantID, request, idempotencyKeyRef.current);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Feedback could not be sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <SpaceDialogFrame ariaLabel="Send feedback" dataFeedbackPrivate dialogRef={dialogRef} onClose={onClose} onSubmit={(event) => void handleSubmit(event)}>
      <SpaceDialogHeading title="Send feedback" description="Tell Chalk what happened. We include safe Dashboard context and an optional screenshot." />
      {submitted ? (
        <>
          <p className="feedback-dialog-status" role="status">
            Thanks. Chalk received your feedback.
          </p>
          <div className="dialog-actions">
            <button type="button" className="dashboard-button primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <fieldset>
            <legend>Feedback type</legend>
            {CATEGORIES.map((option) => (
              <label key={option.value} className="visibility-option">
                <input
                  type="radio"
                  name="dashboard-feedback-category"
                  value={option.value}
                  checked={category === option.value}
                  onChange={() => {
                    setCategory(option.value);
                    invalidateRequest();
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>

          <label htmlFor="dashboard-feedback-message">
            Message
            <textarea
              id="dashboard-feedback-message"
              required
              maxLength={8_000}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                invalidateRequest();
              }}
              placeholder="What should we know?"
              autoFocus
            />
          </label>
          <div className="feedback-dialog-screenshot" aria-live="polite">
            <div className="feedback-dialog-screenshot-heading">
              <strong>Screenshot</strong>
              <span>
                <button type="button" className="dashboard-button secondary" onClick={() => void capture()} disabled={capturing}>
                  {capturing ? "Capturing…" : "Refresh"}
                </button>{" "}
                <button
                  type="button"
                  className="dashboard-button secondary"
                  onClick={() => {
                    setScreenshot({ state: "removed" });
                    invalidateRequest();
                  }}
                  disabled={capturing || !isCapturedScreenshot(screenshot)}
                >
                  Remove
                </button>
              </span>
            </div>
            {isCapturedScreenshot(screenshot) ? (
              <img src={screenshotDataUrl(screenshot)} alt="Dashboard screenshot preview" />
            ) : (
              <p>{capturing ? "Capturing a safe Dashboard screenshot…" : screenshot.failure_code ? `Screenshot unavailable (${screenshot.failure_code}).` : "No screenshot attached."}</p>
            )}
          </div>
          <SpaceDialogActions onClose={onClose} disabled={!message.trim() || sending || capturing} busyLabel={sending ? "Sending…" : undefined} submitLabel="Send feedback" />
          <SpaceDialogError message={error} />
        </>
      )}
    </SpaceDialogFrame>
  );
}

function feedbackRequest(category: FeedbackCategory, message: string, screenshot: FeedbackScreenshotResult, context?: { journeyId: string; rootJourneyId: string; traceparent?: string }): FeedbackReportRequestV1 {
  const evidenceInput = collectBrowserFeedbackEvidence();
  const evidence = collectFeedbackEvidence(
    {
      ...evidenceInput,
      cookies: { ...evidenceInput.cookies, account_present: true },
      screenshot,
    },
    context ? { correlations: feedbackCorrelations(context) } : {},
  );
  return {
    schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION,
    category,
    message,
    source: "dashboard",
    evidence,
    ...(isCapturedScreenshot(screenshot) ? { screenshot: screenshotPayload(screenshot) } : {}),
  };
}

function feedbackCorrelations(context: { journeyId: string; rootJourneyId: string; traceparent?: string }) {
  const trace = context.traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u);
  return {
    journey_id: context.journeyId,
    root_journey_id: context.rootJourneyId,
    ...(trace ? { trace_id: trace[1], span_id: trace[2] } : {}),
  };
}

function screenshotPayload(value: FeedbackScreenshotCapture) {
  return {
    schema_version: "FeedbackScreenshot/v1" as const,
    mime_type: value.mime_type,
    width: value.width,
    height: value.height,
    captured_at: value.captured_at,
    data_base64: value.data_base64,
  };
}

function screenshotDataUrl(value: FeedbackScreenshotCapture): string {
  return `data:${value.mime_type};base64,${value.data_base64}`;
}

function isCapturedScreenshot(value: FeedbackScreenshotResult): value is FeedbackScreenshotCapture {
  return value.state === "captured" || value.state === "partial";
}

function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
}
