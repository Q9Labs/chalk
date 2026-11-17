package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel/trace"
)

// claimAttemptContext puts one claimed attempt on the Episode's journey and trace. The API names
// both in the claim, so a recorder log row and span read on the same timeline as the Space and
// Episode events that led to them. Span ids stay deterministic per claim and envelope: a replayed
// claim lands on the same spans.
//
// An API that predates journey carry sends neither id. The attempt then opens a journey of its
// own from the claim request id, as before, so a mixed rollout still records.
func claimAttemptContext(ctx context.Context, claim ClaimResult, domain string, invalid error) (context.Context, error) {
	if claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size {
		return nil, fmt.Errorf("%w: %s attempt correlation", invalid, domain)
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("chalk.recording." + domain + "_attempt.v1"))
	claimRequestID := claim.ClaimRequestID.Bytes()
	_, _ = digest.Write(claimRequestID[:])
	_, _ = digest.Write(claim.EnvelopeDigest)
	correlation := digest.Sum(nil)
	defer clear(correlation)
	var traceID trace.TraceID
	var spanID trace.SpanID
	copy(traceID[:], correlation[:len(traceID)])
	copy(spanID[:], correlation[len(traceID):len(traceID)+len(spanID)])
	if episodeTrace, ok := parseTraceID(claim.TraceID); ok {
		traceID = episodeTrace
	}
	if !traceID.IsValid() || !spanID.IsValid() {
		return nil, fmt.Errorf("%w: %s attempt trace correlation", invalid, domain)
	}
	journeyID := claim.JourneyID
	if journeyID.IsZero() {
		journeyID = claim.ClaimRequestID
	}
	ctx = observability.ContextWithJourneyID(ctx, journeyID)
	ctx = observability.ContextWithRecordingFields(ctx, observability.RecordingFields{
		TenantID: claim.Envelope.TenantID, EpisodeID: claim.Envelope.EpisodeID, RecordingID: claim.Envelope.RecordingID,
		JobID: claim.Envelope.JobID, Attempt: claim.Envelope.AttemptCount, CaptureEpoch: claim.Envelope.CaptureEpoch,
	})
	return trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	})), nil
}

func parseTraceID(value string) (trace.TraceID, bool) {
	var id trace.TraceID
	if len(value) != hex.EncodedLen(len(id)) {
		return trace.TraceID{}, false
	}
	if _, err := hex.Decode(id[:], []byte(value)); err != nil || !id.IsValid() {
		return trace.TraceID{}, false
	}
	return id, true
}
