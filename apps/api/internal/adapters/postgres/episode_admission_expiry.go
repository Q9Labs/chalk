package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Expiry uses the same operation and reservation as a host's denial. The
// existing deadline worker owns this sweep even when a waiting guest closes.
func enqueueDueAdmissionRequests(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, limit int32) (int, []uncollectedAdmissionOutcome, error) {
	if limit <= 0 {
		return 0, nil, nil
	}
	if err := queries.DeleteOrphanAdmissionInvalidations(ctx, limit); err != nil {
		return 0, nil, fmt.Errorf("delete orphan admission invalidations: %w", err)
	}
	due, err := queries.ListDueAdmissionRequests(ctx, limit)
	if err != nil {
		return 0, nil, fmt.Errorf("list due admission requests: %w", err)
	}
	count := 0
	var outcomes []uncollectedAdmissionOutcome
	for _, candidate := range due {
		tenantID, spaceID, episodeID := utilities.IDFromBytes(candidate.TenantID.Bytes), utilities.IDFromBytes(candidate.SpaceID.Bytes), utilities.IDFromBytes(candidate.EpisodeID.Bytes)
		if _, err := lockLifecycleControlRow(ctx, queries, tenantID, spaceID, episodeID); err != nil {
			return count, nil, err
		}
		episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
		if err != nil {
			return count, nil, err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			if err := queries.DeleteAdmissionInvalidation(ctx, candidate.AdmissionRequestID); err != nil {
				return count, nil, err
			}
			continue
		}
		request, err := queries.LockEpisodeAdmissionRequest(ctx, sqlc.LockEpisodeAdmissionRequestParams{TenantID: candidate.TenantID, SpaceID: candidate.SpaceID, EpisodeID: candidate.EpisodeID, AdmissionRequestID: candidate.AdmissionRequestID})
		if err != nil {
			return count, nil, err
		}
		// Lock before acknowledging queue work. A concurrent revocation either
		// precedes this validation or enqueues after this transaction commits.
		var arrivalState pgtype.Text
		if candidate.PublicArrivalHandle.Valid {
			arrival, err := queries.LockSpacePublicArrival(ctx, candidate.PublicArrivalHandle)
			if err != nil {
				return count, nil, err
			}
			arrivalState = textValue(arrival.State)
		}
		if err := queries.DeleteAdmissionInvalidation(ctx, candidate.AdmissionRequestID); err != nil {
			return count, nil, err
		}
		if request.Status == "admitted" && candidate.PublicArrivalHandle.Valid {
			cleanupCtx := ctx
			if candidate.JourneyID.Valid {
				cleanupCtx = observability.ContextWithJourneyID(cleanupCtx, utilities.IDFromBytes(candidate.JourneyID.Bytes))
			}
			reserved, arrival, err := expireUncollectedAdmission(cleanupCtx, queries, tx, request, candidate.PublicArrivalHandle)
			if err != nil {
				return count, nil, err
			}
			if reserved {
				count++
			}
			if arrival != nil {
				outcomes = append(outcomes, uncollectedAdmissionOutcome{ctx: cleanupCtx, arrival: *arrival, traceID: candidate.ProducingTraceID.String, spanID: candidate.ProducingSpanID.String})
			}
			continue
		}
		if request.Status != "pending" || request.DecisionExternalOperationID.Valid {
			continue
		}
		due, err := queries.IsAdmissionRequestExpiryDue(ctx, sqlc.IsAdmissionRequestExpiryDueParams{ExpiresAt: request.ExpiresAt, ArrivalState: arrivalState})
		if err != nil {
			return count, nil, fmt.Errorf("validate admission expiry: %w", err)
		}
		if !due {
			continue
		}
		requestID := utilities.IDFromBytes(request.AdmissionRequestID.Bytes)
		payload, err := json.Marshal(struct {
			ID string `json:"admissionRequestId"`
		}{requestID.String()})
		if err != nil {
			return count, nil, err
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
		input := tenantExternalOperationInput{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, OperationName: "admission_request_expired",
			Request: episodes.Request{Key: "expired_" + requestID.String(), Fingerprint: sha256.Sum256(payload)},
			Payload: payload, JourneyName: "participant.admission_expired",
		}
		operation, err := createOrRetryAdmissionDecision(expiryCtx, queries, tx, input)
		if err != nil {
			span.RecordError(err)
		}
		span.End()
		if err != nil {
			return count, nil, err
		}
		reserved, err := queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, AdmissionRequestID: request.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
		if err != nil {
			return count, nil, err
		}
		if reserved != 1 {
			return count, nil, episodes.ErrIdempotencyConflict
		}
		count++
	}
	return count, outcomes, nil
}

func createOrRetryAdmissionDecision(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput) (sqlc.SyncExternalOperation, error) {
	operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, input.OperationName, input.Request)
	if errors.Is(err, pgx.ErrNoRows) {
		return createTenantExternalOperation(ctx, queries, tx, input)
	}
	if err != nil || operation.Status != "failed" {
		return operation, err
	}
	return queries.RequeueFailedAdmissionDecision(ctx, sqlc.RequeueFailedAdmissionDecisionParams{
		TenantID: operation.TenantID, EpisodeID: operation.EpisodeID, ExternalOperationID: operation.ExternalOperationID,
	})
}

func expireUncollectedAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, request sqlc.SyncAdmissionRequest, handle pgtype.UUID) (bool, *publicinvites.Arrival, error) {
	arrival, err := queries.LockSpacePublicArrival(ctx, handle)
	if err != nil {
		return false, nil, err
	}
	if arrival.State != "pending" && arrival.State != "unavailable" && arrival.State != "rejected" {
		return false, nil, nil
	}
	now := time.Now()
	if arrival.State == "pending" && (request.ExpiresAt.Time.After(now) || request.CompletedAt.Time.Add(time.Minute).After(now)) {
		return false, nil, nil
	}
	tenantID, spaceID, episodeID := utilities.IDFromBytes(request.TenantID.Bytes), utilities.IDFromBytes(request.SpaceID.Bytes), utilities.IDFromBytes(request.EpisodeID.Bytes)
	participantID := utilities.IDFromBytes(request.ParticipantID.Bytes)
	participant, err := lockLifecycleParticipant(ctx, queries, tenantID, spaceID, episodeID, participantID)
	if err != nil {
		return false, nil, err
	}
	if participant.Status != episodes.ParticipantStatusActive {
		return false, nil, nil
	}
	payload := []byte(`{}`)
	input := tenantExternalOperationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		OperationName:       episodes.OperationRemoveParticipant,
		Request:             episodes.Request{Key: "uncollected_" + utilities.IDFromBytes(request.AdmissionRequestID.Bytes).String(), Fingerprint: sha256.Sum256(payload)},
		TargetParticipantID: participantID, TargetParticipantGeneration: participant.Generation,
		JourneyName: "participant.admission_not_collected", Payload: payload,
	}
	// One retained operation per admission. After rollback, re-reserve only
	// under current participant authority; cap the delay, not eventual recovery.
	operation, err := lockTenantExternalOperation(ctx, queries, tenantID, spaceID, episodeID, input.OperationName, input.Request)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		_, _, err = createParticipantRemovalOperation(ctx, queries, tx, input, participant)
	case err != nil:
		return false, nil, err
	case operation.Status != "failed":
		return false, nil, nil
	default:
		operation, err = queries.RequeueFailedUncollectedRemoval(ctx, sqlc.RequeueFailedUncollectedRemovalParams{
			TenantID: request.TenantID, EpisodeID: request.EpisodeID, ExternalOperationID: operation.ExternalOperationID,
			ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil, nil
		}
		if err == nil {
			_, _, err = reserveParticipantRemovalOperation(ctx, queries, input, participant, operation)
		}
	}
	if err != nil {
		return false, nil, err
	}
	if arrival.TerminalReason.String == "admission_not_collected" {
		return true, nil, nil
	}
	if err := queries.ExpireUncollectedPublicArrival(ctx, sqlc.ExpireUncollectedPublicArrivalParams{TenantID: request.TenantID, ArrivalHandle: handle}); err != nil {
		return false, nil, err
	}
	outcome := mapPublicArrival(arrival)
	outcome.State = publicinvites.ArrivalUnavailable
	outcome.TerminalReason = "admission_not_collected"
	return true, &outcome, nil
}

// Emit only after the arrival transition and removal reservation commit.
type uncollectedAdmissionOutcome struct {
	ctx     context.Context
	arrival publicinvites.Arrival
	traceID string
	spanID  string
}

func (o uncollectedAdmissionOutcome) record() {
	options := []trace.SpanStartOption{trace.WithNewRoot()}
	traceID, traceErr := trace.TraceIDFromHex(o.traceID)
	spanID, spanErr := trace.SpanIDFromHex(o.spanID)
	if traceErr == nil && spanErr == nil {
		options = append(options, trace.WithLinks(trace.Link{SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID})}))
	}
	ctx, span := otel.Tracer("chalk.public_invite").Start(o.ctx, "admission.not_collected", options...)
	defer span.End()
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		span.SetAttributes(attribute.String("journey.id", journeyID.String()))
	}
	publicinvites.RecordAdmissionOutcome(ctx, o.arrival, "admission_not_collected")
}
