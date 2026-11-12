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
	due, err := queries.ListDueAdmissionRequests(ctx, limit)
	if err != nil {
		return 0, nil, fmt.Errorf("list due admission requests: %w", err)
	}
	count := 0
	var outcomes []uncollectedAdmissionOutcome
	for _, candidate := range due {
		expired, outcome, err := expireAdmissionCandidate(ctx, queries, tx, candidate)
		if err != nil {
			return count, nil, err
		}
		if expired {
			count++
		}
		if outcome != nil {
			outcomes = append(outcomes, *outcome)
		}
	}
	return count, outcomes, nil
}

// expireAdmissionCandidate takes the locks in control, Episode, request order and then either releases
// an admission its guest never collected or enqueues the expiry operation for a pending request.
func expireAdmissionCandidate(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, candidate sqlc.ListDueAdmissionRequestsRow) (bool, *uncollectedAdmissionOutcome, error) {
	tenantID, spaceID, episodeID := utilities.IDFromBytes(candidate.TenantID.Bytes), utilities.IDFromBytes(candidate.SpaceID.Bytes), utilities.IDFromBytes(candidate.EpisodeID.Bytes)
	if _, err := lockLifecycleControlRow(ctx, queries, tenantID, spaceID, episodeID); err != nil {
		return false, nil, err
	}
	episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
	if err != nil {
		return false, nil, err
	}
	if episode.Status != episodes.EpisodeStatusActive {
		return false, nil, nil
	}
	request, err := queries.LockEpisodeAdmissionRequest(ctx, sqlc.LockEpisodeAdmissionRequestParams{TenantID: candidate.TenantID, SpaceID: candidate.SpaceID, EpisodeID: candidate.EpisodeID, AdmissionRequestID: candidate.AdmissionRequestID})
	if err != nil {
		return false, nil, err
	}
	if request.Status == "admitted" && candidate.PublicArrivalHandle.Valid {
		return releaseUncollectedAdmission(ctx, queries, tx, candidate, request)
	}
	if request.Status != "pending" || request.DecisionExternalOperationID.Valid {
		return false, nil, nil
	}
	due, err := admissionExpiryDue(ctx, queries, candidate, request)
	if err != nil || !due {
		return false, nil, err
	}
	if err := enqueueAdmissionExpiry(ctx, queries, tx, candidate, request); err != nil {
		return false, nil, err
	}
	return true, nil, nil
}

func releaseUncollectedAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, candidate sqlc.ListDueAdmissionRequestsRow, request sqlc.SyncAdmissionRequest) (bool, *uncollectedAdmissionOutcome, error) {
	cleanupCtx := journeyContext(ctx, candidate)
	arrival, err := expireUncollectedAdmission(cleanupCtx, queries, tx, request, candidate.PublicArrivalHandle)
	if err != nil || arrival == nil {
		return false, nil, err
	}
	return true, &uncollectedAdmissionOutcome{ctx: cleanupCtx, arrival: *arrival, traceID: candidate.ProducingTraceID.String, spanID: candidate.ProducingSpanID.String}, nil
}

func journeyContext(ctx context.Context, candidate sqlc.ListDueAdmissionRequestsRow) context.Context {
	if candidate.JourneyID.Valid {
		return observability.ContextWithJourneyID(ctx, utilities.IDFromBytes(candidate.JourneyID.Bytes))
	}
	return ctx
}

// admissionExpiryDue rechecks, with the public arrival locked, that the request still has to expire.
func admissionExpiryDue(ctx context.Context, queries *sqlc.Queries, candidate sqlc.ListDueAdmissionRequestsRow, request sqlc.SyncAdmissionRequest) (bool, error) {
	var arrivalState pgtype.Text
	if candidate.PublicArrivalHandle.Valid {
		arrival, err := queries.LockSpacePublicArrival(ctx, candidate.PublicArrivalHandle)
		if err != nil {
			return false, err
		}
		arrivalState = textValue(arrival.State)
	}
	due, err := queries.IsAdmissionRequestExpiryDue(ctx, sqlc.IsAdmissionRequestExpiryDueParams{ExpiresAt: request.ExpiresAt, ArrivalState: arrivalState})
	if err != nil {
		return false, fmt.Errorf("validate admission expiry: %w", err)
	}
	return due, nil
}

// enqueueAdmissionExpiry creates the expiry operation under a new root span linked to the span that
// produced the request, then reserves the decision.
func enqueueAdmissionExpiry(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, candidate sqlc.ListDueAdmissionRequestsRow, request sqlc.SyncAdmissionRequest) error {
	requestID := utilities.IDFromBytes(request.AdmissionRequestID.Bytes)
	payload, err := json.Marshal(struct {
		ID string `json:"admissionRequestId"`
	}{requestID.String()})
	if err != nil {
		return err
	}
	options := []trace.SpanStartOption{trace.WithNewRoot()}
	traceID, traceErr := trace.TraceIDFromHex(candidate.ProducingTraceID.String)
	spanID, spanErr := trace.SpanIDFromHex(candidate.ProducingSpanID.String)
	if traceErr == nil && spanErr == nil {
		options = append(options, trace.WithLinks(trace.Link{SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID})}))
	}
	expiryCtx, span := otel.Tracer("chalk.public_invite").Start(journeyContext(ctx, candidate), "admission.expire", options...)
	operation, err := createOrRetryAdmissionDecision(expiryCtx, queries, tx, tenantExternalOperationInput{
		TenantID: utilities.IDFromBytes(candidate.TenantID.Bytes), SpaceID: utilities.IDFromBytes(candidate.SpaceID.Bytes), EpisodeID: utilities.IDFromBytes(candidate.EpisodeID.Bytes),
		OperationName: "admission_request_expired",
		Request:       episodes.Request{Key: "expired_" + requestID.String(), Fingerprint: sha256.Sum256(payload)},
		Payload:       payload, JourneyName: "participant.admission_expired",
	})
	if err != nil {
		span.RecordError(err)
	}
	span.End()
	if err != nil {
		return err
	}
	reserved, err := queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, AdmissionRequestID: request.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
	if err != nil {
		return err
	}
	if reserved != 1 {
		return episodes.ErrIdempotencyConflict
	}
	return nil
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

func expireUncollectedAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, request sqlc.SyncAdmissionRequest, handle pgtype.UUID) (*publicinvites.Arrival, error) {
	arrival, err := queries.LockSpacePublicArrival(ctx, handle)
	if err != nil {
		return nil, err
	}
	if arrival.State != "pending" && arrival.State != "unavailable" && arrival.State != "rejected" {
		return nil, nil
	}
	now := time.Now()
	if arrival.State == "pending" && (request.ExpiresAt.Time.After(now) || request.CompletedAt.Time.Add(time.Minute).After(now)) {
		return nil, nil
	}
	tenantID, spaceID, episodeID := utilities.IDFromBytes(request.TenantID.Bytes), utilities.IDFromBytes(request.SpaceID.Bytes), utilities.IDFromBytes(request.EpisodeID.Bytes)
	participantID := utilities.IDFromBytes(request.ParticipantID.Bytes)
	participant, err := lockLifecycleParticipant(ctx, queries, tenantID, spaceID, episodeID, participantID)
	if err != nil {
		return nil, err
	}
	if participant.Status != episodes.ParticipantStatusActive {
		return nil, nil
	}
	key, err := utilities.NewID()
	if err != nil {
		return nil, err
	}
	payload := []byte(`{}`)
	// Only an active seat can reserve removal. A failed removal restores that
	// state, so a later sweep can safely reserve a new attempt with fresh fences.
	if _, _, err := createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		OperationName:       episodes.OperationRemoveParticipant,
		Request:             episodes.Request{Key: "uncollected_" + key.String(), Fingerprint: sha256.Sum256(payload)},
		TargetParticipantID: participantID, TargetParticipantGeneration: participant.Generation,
		JourneyName: "participant.admission_not_collected", Payload: payload,
	}, participant); err != nil {
		return nil, err
	}
	if err := queries.ExpireUncollectedPublicArrival(ctx, sqlc.ExpireUncollectedPublicArrivalParams{TenantID: request.TenantID, ArrivalHandle: handle}); err != nil {
		return nil, err
	}
	outcome := mapPublicArrival(arrival)
	outcome.State = publicinvites.ArrivalUnavailable
	outcome.TerminalReason = "admission_not_collected"
	return &outcome, nil
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
