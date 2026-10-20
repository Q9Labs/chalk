package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// Expiry uses the same operation and reservation as a host's denial. The
// existing deadline worker owns this sweep even when a waiting guest closes.
func enqueueDueAdmissionRequests(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, limit int32) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	due, err := queries.ListDueAdmissionRequests(ctx, limit)
	if err != nil {
		return 0, fmt.Errorf("list due admission requests: %w", err)
	}
	count := 0
	for _, candidate := range due {
		tenantID, spaceID, episodeID := utilities.IDFromBytes(candidate.TenantID.Bytes), utilities.IDFromBytes(candidate.SpaceID.Bytes), utilities.IDFromBytes(candidate.EpisodeID.Bytes)
		if _, err := lockLifecycleControlRow(ctx, queries, tenantID, spaceID, episodeID); err != nil {
			return count, err
		}
		episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
		if err != nil {
			return count, err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			continue
		}
		request, err := queries.LockEpisodeAdmissionRequest(ctx, sqlc.LockEpisodeAdmissionRequestParams{TenantID: candidate.TenantID, SpaceID: candidate.SpaceID, EpisodeID: candidate.EpisodeID, AdmissionRequestID: candidate.AdmissionRequestID})
		if err != nil {
			return count, err
		}
		if request.Status != "pending" || request.DecisionExternalOperationID.Valid {
			continue
		}
		invalidated := false
		if candidate.PublicArrivalHandle.Valid {
			arrival, err := queries.LockSpacePublicArrival(ctx, candidate.PublicArrivalHandle)
			if err != nil {
				return count, err
			}
			invalidated = arrival.State == "unavailable" || arrival.State == "rejected" || arrival.State == "left"
		}
		if request.ExpiresAt.Time.After(time.Now()) && !invalidated {
			continue
		}
		requestID := utilities.IDFromBytes(request.AdmissionRequestID.Bytes)
		payload, err := json.Marshal(struct {
			ID string `json:"admissionRequestId"`
		}{requestID.String()})
		if err != nil {
			return count, err
		}
		expiryCtx := ctx
		if candidate.JourneyID.Valid {
			expiryCtx = observability.ContextWithJourneyID(expiryCtx, utilities.IDFromBytes(candidate.JourneyID.Bytes))
		}
		options := []trace.SpanStartOption{trace.WithNewRoot()}
		traceID, traceErr := trace.TraceIDFromHex(candidate.ProducingTraceID.String)
		spanID, spanErr := trace.SpanIDFromHex(candidate.ProducingSpanID.String)
		if traceErr == nil && spanErr == nil {
			options = append(options, trace.WithLinks(trace.Link{SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID})}))
		}
		expiryCtx, span := otel.Tracer("chalk.public_invite").Start(expiryCtx, "admission.expire", options...)
		operation, err := createTenantExternalOperation(expiryCtx, queries, tx, tenantExternalOperationInput{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, OperationName: "admission_request_expired",
			Request: episodes.Request{Key: "expired_" + requestID.String(), Fingerprint: sha256.Sum256(payload)},
			Payload: payload, JourneyName: "participant.admission_expired",
		})
		if err != nil {
			span.RecordError(err)
		}
		span.End()
		if err != nil {
			return count, err
		}
		reserved, err := queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, AdmissionRequestID: request.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
		if err != nil {
			return count, err
		}
		if reserved != 1 {
			return count, episodes.ErrIdempotencyConflict
		}
		count++
	}
	return count, nil
}
