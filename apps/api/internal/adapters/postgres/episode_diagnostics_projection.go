package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var diagnosticAdapterTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/postgres/episode-diagnostics")

// Projector state is unbounded by viewer page caps. It walks the durable
// operation/issue projections with keyset pages so a 1M-event Episode cannot
// silently forget an older operation when replaying a later batch.
const diagnosticProjectorOperationLimit = 0

const diagnosticProjectorFailureThreshold = 3

func (r *EpisodeDiagnosticsRepository) Project(ctx context.Context, owner string, batch int) (int, error) {
	if r.queryPool == nil {
		return 0, errDiagnosticsUnavailable
	}
	if batch <= 0 {
		batch = episodediagnostics.DefaultPageSize
	}
	if batch > episodediagnostics.MaxPageSize {
		batch = episodediagnostics.MaxPageSize
	}
	leaseID, err := utilities.NewID()
	if err != nil {
		return 0, fmt.Errorf("generate projector lease: %w", err)
	}
	queries := sqlc.New(r.queryPool)
	claims, err := queries.ClaimProjectorOffsets(ctx, sqlc.ClaimProjectorOffsetsParams{LeaseToken: uuid(leaseID), LeaseOwner: diagnosticText(owner), LeaseSeconds: diagnosticProjectorLeaseSeconds, PageLimit: int32(batch)})
	if err != nil {
		return 0, fmt.Errorf("claim diagnostic projector offsets: %w", err)
	}
	processed := 0
	for _, claim := range claims {
		events, listErr := queries.ListUnprojectedEvents(ctx, sqlc.ListUnprojectedEventsParams{TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, PageLimit: int32(batch)})
		if listErr != nil {
			_ = r.recordProjectorFailure(ctx, claim, "query", listErr)
			continue
		}
		if len(events) == 0 {
			_, advanceErr := queries.AdvanceProjectorOffset(ctx, sqlc.AdvanceProjectorOffsetParams{ProjectedCursor: claim.ProjectedCursor, TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: uuid(leaseID)})
			if advanceErr != nil && !errors.Is(advanceErr, pgx.ErrNoRows) {
				return processed, fmt.Errorf("release idle projector lease: %w", advanceErr)
			}
			continue
		}

		rootRow, rootErr := queries.GetEpisodeDiagnosticByOpaqueID(ctx, sqlc.GetEpisodeDiagnosticByOpaqueIDParams{TenantID: claim.TenantID, ID: claim.DiagnosticID})
		if rootErr != nil {
			_ = r.recordProjectorFailure(ctx, claim, "root_lookup", rootErr)
			continue
		}
		root := mapEpisodeDiagnostic(rootRow)
		targetedOperationIDs := make([]string, 0, len(events))
		for _, event := range events {
			targetedOperationIDs = append(targetedOperationIDs, diagnosticOperationIDForEvent(mapDiagnosticEventForProjection(event)))
		}
		state, _, loadErr := r.loadProjectionState(ctx, queries, root, episodediagnostics.DiagnosticFilterV1{}, diagnosticProjectorOperationLimit, 0, episodediagnostics.MaxSnapshotBranches, targetedOperationIDs)
		if loadErr != nil {
			_ = r.recordProjectorFailure(ctx, claim, "projection_load", loadErr)
			continue
		}
		accepted := make([]episodediagnostics.AcceptedDiagnosticEvent, 0, len(events))
		for _, event := range events {
			eventCtx, eventSpan := startDiagnosticLinkedSpan(ctx, "episode_diagnostics.project.event", nullableString(event.TraceID), nullableString(event.SpanID), event.Source, event.Name)
			_ = eventCtx
			accepted = append(accepted, mapDiagnosticEventForProjection(event))
			eventSpan.SetStatus(codes.Ok, "accepted event projected")
			eventSpan.End()
		}
		delta, projectErr := episodediagnostics.ApplyDiagnosticEvents(&state, accepted)
		if projectErr != nil {
			_ = r.recordProjectorFailure(ctx, claim, "projection_reduce", projectErr)
			continue
		}
		if persistErr := r.persistProjection(ctx, claim, root, state, delta, leaseID); persistErr != nil {
			_ = r.recordProjectorFailure(ctx, claim, "projection_write", persistErr)
			continue
		}
		processed += len(events)
	}
	return processed, nil
}

func (r *EpisodeDiagnosticsRepository) ScanDeadlines(ctx context.Context, now time.Time, limit int) (int, error) {
	if r.queryPool == nil {
		return 0, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	queries := sqlc.New(r.queryPool)
	operations, err := queries.ScanOperationDeadlinesGlobal(ctx, sqlc.ScanOperationDeadlinesGlobalParams{NowAt: timestamptz(&now), PageLimit: int32(limit)})
	if err != nil {
		return 0, fmt.Errorf("scan diagnostic operation deadlines: %w", err)
	}
	graceOperations, err := queries.ScanOperationGraceDeadlinesGlobal(ctx, sqlc.ScanOperationGraceDeadlinesGlobalParams{NowAt: timestamptz(&now), PageLimit: int32(limit)})
	if err != nil {
		return 0, fmt.Errorf("scan diagnostic operation grace deadlines: %w", err)
	}
	branches, err := queries.ScanBranchDeadlinesGlobal(ctx, sqlc.ScanBranchDeadlinesGlobalParams{NowAt: timestamptz(&now), PageLimit: int32(limit)})
	if err != nil {
		return 0, fmt.Errorf("scan diagnostic branch deadlines: %w", err)
	}
	now = now.UTC()
	rootCache := make(map[string]episodediagnostics.EpisodeDiagnostic)
	loadRoot := func(tenantID, diagnosticID pgtype.UUID) (episodediagnostics.EpisodeDiagnostic, error) {
		key := idString(tenantID) + ":" + idString(diagnosticID)
		if root, ok := rootCache[key]; ok {
			return root, nil
		}
		row, lookupErr := queries.GetEpisodeDiagnosticByOpaqueID(ctx, sqlc.GetEpisodeDiagnosticByOpaqueIDParams{TenantID: tenantID, ID: diagnosticID})
		if lookupErr != nil {
			return episodediagnostics.EpisodeDiagnostic{}, lookupErr
		}
		root := mapEpisodeDiagnostic(row)
		rootCache[key] = root
		return root, nil
	}

	count := 0
	for _, operation := range operations {
		root, rootErr := loadRoot(operation.TenantID, operation.DiagnosticID)
		if rootErr != nil {
			return count, fmt.Errorf("load diagnostic root for operation deadline: %w", rootErr)
		}
		checkpoints, checkpointErr := queries.ListDiagnosticCheckpoints(ctx, sqlc.ListDiagnosticCheckpointsParams{TenantID: operation.TenantID, DiagnosticID: operation.DiagnosticID, OperationID: operation.ID})
		if checkpointErr != nil {
			return count, fmt.Errorf("list diagnostic checkpoint deadlines: %w", checkpointErr)
		}
		checkpoint, ok := dueDiagnosticCheckpoint(checkpoints, now)
		if !ok {
			continue
		}
		event := syntheticCheckpointDeadlineEvent(operation, checkpoint, now)
		validated, validationErr := episodediagnostics.ValidateDraft(event)
		if validationErr != nil {
			return count, fmt.Errorf("validate synthetic operation deadline event: %w", validationErr)
		}
		result, appendErr := r.appendAt(ctx, root, nil, []episodediagnostics.ValidatedEvent{validated}, now, true)
		if appendErr != nil {
			if errors.Is(appendErr, episodediagnostics.ErrIntakeClosed) || errors.Is(appendErr, episodediagnostics.ErrDiagnosticExpired) || errors.Is(appendErr, episodediagnostics.ErrNotFound) {
				continue
			}
			return count, fmt.Errorf("append synthetic operation deadline event: %w", appendErr)
		}
		count += len(result.Accepted)
	}
	for _, operation := range graceOperations {
		root, rootErr := loadRoot(operation.TenantID, operation.DiagnosticID)
		if rootErr != nil {
			return count, fmt.Errorf("load diagnostic root for operation grace deadline: %w", rootErr)
		}
		event := syntheticOperationDeadlineEvent(operation, now)
		validated, validationErr := episodediagnostics.ValidateDraft(event)
		if validationErr != nil {
			return count, fmt.Errorf("validate synthetic operation timeout event: %w", validationErr)
		}
		result, appendErr := r.appendAt(ctx, root, nil, []episodediagnostics.ValidatedEvent{validated}, now, true)
		if appendErr != nil {
			if errors.Is(appendErr, episodediagnostics.ErrIntakeClosed) || errors.Is(appendErr, episodediagnostics.ErrDiagnosticExpired) || errors.Is(appendErr, episodediagnostics.ErrNotFound) {
				continue
			}
			return count, fmt.Errorf("append synthetic operation timeout event: %w", appendErr)
		}
		count += len(result.Accepted)
	}
	for _, branch := range branches {
		if !branch.BranchOperationID.Valid {
			return count, fmt.Errorf("diagnostic branch %s has no owning operation", idString(branch.ID))
		}
		root, rootErr := loadRoot(branch.TenantID, branch.DiagnosticID)
		if rootErr != nil {
			return count, fmt.Errorf("load diagnostic root for branch deadline: %w", rootErr)
		}
		event := syntheticBranchDeadlineEvent(branch, now)
		validated, validationErr := episodediagnostics.ValidateDraft(event)
		if validationErr != nil {
			return count, fmt.Errorf("validate synthetic branch deadline event: %w", validationErr)
		}
		result, appendErr := r.appendAt(ctx, root, nil, []episodediagnostics.ValidatedEvent{validated}, now, true)
		if appendErr != nil {
			if errors.Is(appendErr, episodediagnostics.ErrIntakeClosed) || errors.Is(appendErr, episodediagnostics.ErrDiagnosticExpired) || errors.Is(appendErr, episodediagnostics.ErrNotFound) {
				continue
			}
			return count, fmt.Errorf("append synthetic branch deadline event: %w", appendErr)
		}
		count += len(result.Accepted)
	}
	return count, nil
}

func syntheticCheckpointDeadlineEvent(operation sqlc.DiagnosticOperation, checkpoint sqlc.DiagnosticCheckpoint, now time.Time) episodediagnostics.DiagnosticEventDraft {
	occurredAt := now
	if checkpoint.DeadlineAt.Valid && checkpoint.DeadlineAt.Time.Before(occurredAt) {
		occurredAt = checkpoint.DeadlineAt.Time.UTC()
	}
	return episodediagnostics.DiagnosticEventDraft{
		Version:              episodediagnostics.ContractVersion,
		EventID:              "deadline:checkpoint:" + idString(operation.ID) + ":" + checkpoint.CheckpointKey,
		OperationID:          idString(operation.ID),
		ProducerOperationRef: nullableString(operation.ProducerOperationRef),
		ProducerSequence:     0,
		OccurredAt:           occurredAt,
		Source:               episodediagnostics.SourceWorker,
		Name:                 "checkpoint.missed",
		Phase:                "timed_out",
		State:                episodediagnostics.EventTimedOut,
		Expectation: &episodediagnostics.DiagnosticEventExpectation{
			Name: operation.Kind, Version: int(operation.ExpectationVersion), Checkpoint: checkpoint.CheckpointKey,
			CheckpointClass: episodediagnostics.CheckpointClass(checkpoint.Class), DeadlineAt: nullableTimestampUTC(checkpoint.DeadlineAt),
		},
		Attributes: episodediagnostics.DiagnosticAttributes{"reason": "deadline"},
	}
}

func syntheticOperationDeadlineEvent(operation sqlc.DiagnosticOperation, now time.Time) episodediagnostics.DiagnosticEventDraft {
	occurredAt := now
	if operation.GraceEndsAt.Valid && operation.GraceEndsAt.Time.Before(occurredAt) {
		occurredAt = operation.GraceEndsAt.Time.UTC()
	}
	return episodediagnostics.DiagnosticEventDraft{
		Version:              episodediagnostics.ContractVersion,
		EventID:              "deadline:operation:" + idString(operation.ID),
		OperationID:          idString(operation.ID),
		ProducerOperationRef: nullableString(operation.ProducerOperationRef),
		ProducerSequence:     0,
		OccurredAt:           occurredAt,
		Source:               episodediagnostics.SourceWorker,
		Name:                 "operation.ended",
		Phase:                "timed_out",
		State:                episodediagnostics.EventTimedOut,
		Attributes:           episodediagnostics.DiagnosticAttributes{"reason": "deadline"},
	}
}

func dueDiagnosticCheckpoint(checkpoints []sqlc.DiagnosticCheckpoint, now time.Time) (sqlc.DiagnosticCheckpoint, bool) {
	for _, checkpoint := range checkpoints {
		if checkpoint.State != string(episodediagnostics.CheckpointPending) || !checkpoint.DeadlineAt.Valid || checkpoint.DeadlineAt.Time.After(now) || checkpoint.Class == string(episodediagnostics.CheckpointBestEffort) {
			continue
		}
		return checkpoint, true
	}
	return sqlc.DiagnosticCheckpoint{}, false
}

func syntheticBranchDeadlineEvent(branch sqlc.ScanBranchDeadlinesGlobalRow, now time.Time) episodediagnostics.DiagnosticEventDraft {
	occurredAt := now
	if branch.LeaseEndsAt.Valid && branch.LeaseEndsAt.Time.Before(occurredAt) {
		occurredAt = branch.LeaseEndsAt.Time.UTC()
	}
	return episodediagnostics.DiagnosticEventDraft{
		Version:              episodediagnostics.ContractVersion,
		EventID:              "deadline:branch:" + idString(branch.ID),
		OperationID:          idString(branch.BranchOperationID),
		ProducerOperationRef: nullableString(branch.BranchOperationRef),
		ProducerSequence:     0,
		OccurredAt:           occurredAt,
		Source:               episodediagnostics.SourceWorker,
		Name:                 syntheticBranchEventName(branch.Kind),
		Phase:                "timed_out",
		State:                episodediagnostics.EventTimedOut,
		Attributes:           episodediagnostics.DiagnosticAttributes{"reason": "deadline"},
	}
}

func syntheticBranchEventName(kind string) string {
	switch kind {
	case "cleanup":
		return "cleanup.resource.release.ended"
	case "recording":
		return "recording.start.ended"
	case "transcription":
		return "transcription.start.ended"
	case "artifact":
		return "artifact.reserve.ended"
	case "webhook":
		return "webhook.enqueue.ended"
	default:
		// The database check makes this unreachable for persisted rows. Keep a
		// valid closed event name if a malformed row reaches the worker.
		return "operation.ended"
	}
}

func (r *EpisodeDiagnosticsRepository) recordProjectorFailure(ctx context.Context, claim sqlc.DiagnosticProjectorOffset, class string, cause error) error {
	if cause == nil {
		return nil
	}
	if r.queryPool == nil {
		return errDiagnosticsUnavailable
	}
	errorClass := boundedProjectorErrorClass(class)
	return withDiagnosticTx(ctx, r.queryPool, func(tx pgx.Tx) error {
		queries := sqlc.New(tx)
		updated, err := queries.RecordProjectorFailure(ctx, sqlc.RecordProjectorFailureParams{ErrorClass: diagnosticText(errorClass), TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: claim.LeaseToken})
		if errors.Is(err, pgx.ErrNoRows) {
			// The lease was reclaimed by another worker; there is no safe event
			// to dead-letter under this claim.
			return nil
		}
		if err != nil {
			return err
		}
		if updated.FailureCount < diagnosticProjectorFailureThreshold {
			_, releaseErr := queries.ReleaseProjectorFailureLease(ctx, sqlc.ReleaseProjectorFailureLeaseParams{TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: claim.LeaseToken})
			return releaseErr
		}

		// Once the same event has failed repeatedly, retain a bounded, safe
		// dead-letter record and move the cursor past that event. The raw cause
		// is intentionally not persisted: driver errors can contain SQL,
		// identifiers, or payload fragments outside the public contract.
		event, eventErr := queries.GetFirstUnprojectedDiagnosticEvent(ctx, sqlc.GetFirstUnprojectedDiagnosticEventParams{TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID})
		if errors.Is(eventErr, pgx.ErrNoRows) {
			_, releaseErr := queries.ReleaseProjectorFailureLease(ctx, sqlc.ReleaseProjectorFailureLeaseParams{TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: claim.LeaseToken})
			return releaseErr
		}
		if eventErr != nil {
			return eventErr
		}
		deadLetterID, idErr := utilities.NewID()
		if idErr != nil {
			return idErr
		}
		if _, insertErr := queries.InsertProjectorDeadLetter(ctx, sqlc.InsertProjectorDeadLetterParams{
			TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, ID: uuid(deadLetterID), EventCursor: event.Cursor,
			EventID: diagnosticText(event.EventID), ErrorClass: errorClass, ErrorReason: "projector failure threshold reached", AttemptCount: updated.FailureCount,
		}); insertErr != nil {
			return insertErr
		}
		fromCursor := claim.ProjectedCursor + 1
		toCursor := event.Cursor
		gapPayload, marshalErr := json.Marshal(episodediagnostics.StreamGap{FromCursor: &fromCursor, ToCursor: &toCursor, Reason: "projector_dead_letter"})
		if marshalErr != nil {
			return marshalErr
		}
		if gapErr := recordProjectionChange(ctx, queries, claim.TenantID, claim.DiagnosticID, event.Cursor, 0, episodediagnostics.StreamDeltaGap, "", "", gapPayload); gapErr != nil {
			return gapErr
		}
		_, advanceErr := queries.AdvanceProjectorOffsetAfterDeadLetter(ctx, sqlc.AdvanceProjectorOffsetAfterDeadLetterParams{ProjectedCursor: event.Cursor, ExpectedProjectedCursor: claim.ProjectedCursor, TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: claim.LeaseToken})
		return advanceErr
	})
}

func boundedProjectorErrorClass(value string) string {
	switch value {
	case "query", "root_lookup", "projection_load", "projection_reduce", "projection_write":
		return value
	default:
		return "unknown"
	}
}

func (r *EpisodeDiagnosticsRepository) persistProjection(ctx context.Context, claim sqlc.DiagnosticProjectorOffset, root episodediagnostics.EpisodeDiagnostic, state episodediagnostics.ProjectionState, delta episodediagnostics.ProjectionDelta, leaseID utilities.ID) error {
	return withDiagnosticTx(ctx, r.queryPool, func(tx pgx.Tx) error {
		queries := sqlc.New(tx)
		for _, branch := range delta.Branches {
			if err := upsertDiagnosticBranch(ctx, queries, claim.TenantID, claim.DiagnosticID, branch); err != nil {
				return err
			}
		}
		for _, operation := range delta.Operations {
			if err := upsertDiagnosticOperation(ctx, queries, claim.TenantID, claim.DiagnosticID, operation); err != nil {
				return err
			}
			for _, checkpoint := range operation.Checkpoints {
				if err := upsertDiagnosticCheckpoint(ctx, queries, claim.TenantID, claim.DiagnosticID, operation.ID, checkpoint); err != nil {
					return err
				}
			}
		}
		for _, event := range delta.Events {
			operationID := diagnosticOperationIDForEvent(event)
			if operationID != "" {
				assigned, err := queries.AssignDiagnosticEventOperation(ctx, sqlc.AssignDiagnosticEventOperationParams{
					TenantID:     claim.TenantID,
					DiagnosticID: claim.DiagnosticID,
					Cursor:       event.Cursor,
					OperationID:  requiredUUID(operationID),
				})
				if err != nil {
					return fmt.Errorf("assign diagnostic event operation: %w", err)
				}
				if assigned != 1 {
					return fmt.Errorf("assign diagnostic event operation: cursor %d did not match expected operation", event.Cursor)
				}
			}
			if err := upsertDiagnosticEventReferences(ctx, queries, claim.TenantID, claim.DiagnosticID, event, operationID); err != nil {
				return err
			}
		}
		for _, issue := range delta.Issues {
			if err := upsertDiagnosticIssue(ctx, queries, claim.TenantID, claim.DiagnosticID, issue); err != nil {
				return err
			}
		}
		if err := queries.RefreshDiagnosticParticipantCounts(ctx, sqlc.RefreshDiagnosticParticipantCountsParams{TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID}); err != nil {
			return fmt.Errorf("refresh diagnostic participant counts: %w", err)
		}
		// A stream resume is cursor-only. Emit one replay-complete snapshot marker
		// per projected cursor; HTTP resolves the marker against the durable,
		// filter-aware snapshot and clients refill Events before applying it.
		fromCursor := claim.ProjectedCursor
		toCursor := delta.Cursor
		_ = fromCursor
		_ = toCursor
		payload, err := json.Marshal(map[string]any{})
		if err != nil {
			return fmt.Errorf("marshal diagnostic projection change: %w", err)
		}
		if delta.Cursor > 0 {
			if err := recordProjectionChange(ctx, queries, claim.TenantID, claim.DiagnosticID, delta.Cursor, 0, episodediagnostics.StreamSnapshot, "", "", payload); err != nil {
				return err
			}
		}

		if delta.Cursor > claim.ProjectedCursor {
			if _, err := queries.AdvanceProjectorOffset(ctx, sqlc.AdvanceProjectorOffsetParams{ProjectedCursor: delta.Cursor, TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID, LeaseToken: uuid(leaseID)}); err != nil {
				return fmt.Errorf("advance diagnostic projector offset: %w", err)
			}
		}
		if state.Diagnostic.State != root.State {
			if err := updateProjectedDiagnosticLifecycle(ctx, queries, claim, root, state.Diagnostic); err != nil {
				return err
			}
		}
		return nil
	})
}

func upsertDiagnosticEventReferences(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, event episodediagnostics.AcceptedDiagnosticEvent, operationID string) error {
	if event.Correlation == nil {
		return nil
	}
	correlation := event.Correlation
	for _, reference := range []struct {
		idClass string
		value   string
	}{
		{idClass: "chalk.request", value: correlation.RequestID},
		{idClass: "chalk.command", value: correlation.CommandID},
		{idClass: "chalk.journey", value: correlation.JourneyID},
	} {
		if reference.value == "" || !episodediagnostics.ValidSafeIdentifierValue(reference.idClass, reference.value) {
			continue
		}
		if err := insertDiagnosticReference(ctx, queries, tenantID, diagnosticID, event.Cursor, operationID, reference.idClass, reference.value, "", true, ""); err != nil {
			return err
		}
	}
	if correlation.TraceID != "" && correlation.SpanID != "" && episodediagnostics.ValidSafeIdentifierValue("w3c.trace", correlation.TraceID) && episodediagnostics.ValidSafeIdentifierValue("w3c.span", correlation.SpanID) {
		value := episodediagnostics.TraceSpanReferenceValue(correlation.TraceID, correlation.SpanID)
		if err := insertDiagnosticReference(ctx, queries, tenantID, diagnosticID, event.Cursor, operationID, "w3c.trace", value, "", true, ""); err != nil {
			return err
		}
	}
	if validStoredProviderHMAC(correlation.ProviderID) {
		if err := insertDiagnosticReference(ctx, queries, tenantID, diagnosticID, event.Cursor, operationID, "provider", correlation.ProviderID, "v1", false, string(episodediagnostics.UnknownProviderOpaque)); err != nil {
			return err
		}
	}
	return nil
}

func insertDiagnosticReference(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, cursor int64, operationID, idClass, value, hmacVersion string, copyable bool, unknownReason string) error {
	params := sqlc.UpsertDiagnosticReferenceParams{
		TenantID: tenantID, DiagnosticID: diagnosticID,
		ReferenceID: diagnosticReferenceID(diagnosticID, idClass, hmacVersion, value),
		IDClass:     idClass, Copyable: copyable,
		OperationID: optionalUUID(operationID),
	}
	if cursor > 0 {
		params.EventCursor = pgtype.Int8{Int64: cursor, Valid: true}
	}
	if hmacVersion == "" {
		params.RawValue = diagnosticText(value)
	} else {
		params.HmacVersion = diagnosticText(hmacVersion)
		params.ValueHmac = diagnosticText(value)
	}
	if unknownReason != "" {
		params.UnknownReason = diagnosticText(unknownReason)
	}
	if _, err := queries.UpsertDiagnosticReference(ctx, params); err != nil {
		return fmt.Errorf("upsert diagnostic %s reference: %w", idClass, err)
	}
	return nil
}

func diagnosticReferenceID(diagnosticID pgtype.UUID, idClass, version, value string) pgtype.UUID {
	digest := sha256.Sum256([]byte(idString(diagnosticID) + "\x00" + idClass + "\x00" + version + "\x00" + value))
	var bytes [16]byte
	copy(bytes[:], digest[:16])
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return pgtype.UUID{Bytes: bytes, Valid: true}
}

func validStoredProviderHMAC(value string) bool {
	encoded, ok := strings.CutPrefix(value, "hmac:v1:")
	if !ok || len(encoded) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(encoded)
	return err == nil
}

func updateProjectedDiagnosticLifecycle(ctx context.Context, queries *sqlc.Queries, claim sqlc.DiagnosticProjectorOffset, previous, next episodediagnostics.EpisodeDiagnostic) error {
	state := string(next.State)
	if state == "" {
		return nil
	}
	var endedAt, completedAt, expiresAt pgtype.Timestamptz
	if next.EpisodeEndedAt != nil {
		endedAt = timestamptz(next.EpisodeEndedAt)
	}
	if next.EpilogueCompletedAt != nil {
		completedAt = timestamptz(next.EpilogueCompletedAt)
		expiresAt = timestamptz(nonZeroTimePtr(next.EpilogueCompletedAt.Add(episodediagnostics.RetentionPeriod)))
	}
	if state == string(episodediagnostics.DiagnosticComplete) && !expiresAt.Valid {
		expiresAt = timestamptz(nonZeroTimePtr(time.Now().UTC().Add(episodediagnostics.RetentionPeriod)))
	}
	var runEnd pgtype.Int8
	if next.RunEndCursor != nil {
		runEnd = pgtype.Int8{Int64: *next.RunEndCursor, Valid: true}
	}
	_, err := queries.UpdateEpisodeDiagnosticLifecycle(ctx, sqlc.UpdateEpisodeDiagnosticLifecycleParams{State: state, EpisodeEndedAt: endedAt, EpilogueCompletedAt: completedAt, ExpiresAt: expiresAt, RunEndCursor: runEnd, TenantID: claim.TenantID, DiagnosticID: claim.DiagnosticID})
	if err != nil {
		return fmt.Errorf("update diagnostic lifecycle from projection: %w", err)
	}
	_ = previous
	return nil
}

func upsertDiagnosticOperation(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, operation episodediagnostics.DiagnosticOperationDetail) error {
	params := sqlc.UpsertDiagnosticOperationParams{TenantID: tenantID, DiagnosticID: diagnosticID, ID: requiredUUID(operation.ID), ParentID: optionalUUID(operation.ParentID), BranchID: optionalUUID(operation.BranchID), ParticipantID: optionalUUID(operation.ParticipantID), Kind: operation.Kind, ExpectationVersion: int32(maxInt(operation.ExpectationVersion, 1)), State: string(operation.State), Attempt: int32(maxInt(operation.Attempt, 1)), StartedAt: timestamptz(&operation.StartedAt), DeadlineAt: optionalTimePtr(operation.DeadlineAt), GraceEndsAt: optionalTimePtr(operation.GraceEndsAt), EndedAt: optionalTimePtr(operation.EndedAt), ErrorClass: diagnosticText(operation.ErrorClass), Source: string(operation.Source), ReleaseID: diagnosticText(operation.ReleaseID), SourceCommit: diagnosticText(operation.SourceCommit), RequestID: storedIdentifier(operation.RequestID), CommandID: storedIdentifier(operation.CommandID), ProviderID: diagnosticText(operation.ProviderLookupID), JourneyID: storedIdentifier(operation.JourneyID), TraceID: storedIdentifier(operation.TraceID), SpanID: storedIdentifier(operation.SpanID), ClockUncertainty: diagnosticText(operation.ClockUncertainty), VisibilityGaps: diagnosticStringSliceJSON(operation.VisibilityGaps), FirstEvidenceCursor: operation.FirstEvidenceCursor, LastEvidenceCursor: optionalInt64Value(operationLastEvidence(operation))}
	_, err := queries.UpsertDiagnosticOperation(ctx, params)
	if err != nil {
		return fmt.Errorf("upsert diagnostic operation: %w", err)
	}
	return nil
}

func upsertDiagnosticCheckpoint(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, operationID string, checkpoint episodediagnostics.DiagnosticCheckpointDetail) error {
	_, err := queries.UpsertDiagnosticCheckpoint(ctx, sqlc.UpsertDiagnosticCheckpointParams{TenantID: tenantID, DiagnosticID: diagnosticID, OperationID: requiredUUID(operationID), CheckpointKey: checkpoint.Key, Class: string(checkpoint.Class), DisplayOrder: int32(checkpoint.DisplayOrder), DeadlineAt: optionalTimePtr(checkpoint.DeadlineAt), State: string(checkpoint.State), EvidenceCursor: optionalInt64Value(checkpoint.EvidenceCursor), UnknownReason: diagnosticText(string(checkpoint.UnknownReason)), Predicate: diagnosticText(checkpoint.Predicate)})
	if err != nil {
		return fmt.Errorf("upsert diagnostic checkpoint: %w", err)
	}
	return nil
}

func upsertDiagnosticIssue(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, issue episodediagnostics.DiagnosticIssueDetail) error {
	affectedKind, affectedClass, affectedValue, affectedCopyable := diagnosticAffectedValues(issue.Affected)
	_, err := queries.UpsertDiagnosticIssue(ctx, sqlc.UpsertDiagnosticIssueParams{TenantID: tenantID, DiagnosticID: diagnosticID, ID: requiredUUID(issue.ID), OperationID: optionalUUID(issue.OperationID), Kind: issue.Kind, Severity: string(issue.Severity), State: string(issue.State), Summary: issue.Summary, AffectedKind: affectedKind, AffectedIDClass: affectedClass, AffectedIDValue: affectedValue, AffectedIDCopyable: affectedCopyable, LastConfirmedCheckpoint: diagnosticText(issue.LastConfirmedCheckpoint), MissingCheckpoint: diagnosticText(issue.MissingCheckpoint), FirstObservedAt: timestamptz(&issue.FirstObservedAt), LastObservedAt: optionalTimePtr(issue.LastObservedAt), ResolvedAt: optionalTimePtr(issue.ResolvedAt), RetryState: diagnosticText(issue.RetryState), UnknownReason: diagnosticText(string(issue.UnknownReason))})
	if err != nil {
		return fmt.Errorf("upsert diagnostic issue: %w", err)
	}
	return nil
}

func diagnosticAffectedValues(value *episodediagnostics.DiagnosticAffectedSubject) (pgtype.Text, pgtype.Text, pgtype.Text, pgtype.Bool) {
	if value == nil || value.Kind == "" || value.Identifier.IDClass == "" {
		return pgtype.Text{}, pgtype.Text{}, pgtype.Text{}, pgtype.Bool{}
	}
	return diagnosticText(value.Kind), diagnosticText(value.Identifier.IDClass), diagnosticText(value.Identifier.Value), pgtype.Bool{Bool: value.Identifier.Copyable, Valid: true}
}

func upsertDiagnosticBranch(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, branch episodediagnostics.DiagnosticBranchDetail) error {
	_, err := queries.UpsertDiagnosticBranch(ctx, sqlc.UpsertDiagnosticBranchParams{TenantID: tenantID, DiagnosticID: diagnosticID, ID: requiredUUID(branch.ID), Kind: string(branch.Kind), State: string(branch.State), LeaseEndsAt: timestamptz(&branch.LeaseEndsAt), StartedAt: optionalTimePtr(branch.StartedAt), TerminalAt: optionalTimePtr(branch.TerminalAt), TerminalCursor: optionalInt64Value(branch.TerminalCursor), Attempts: int32(maxInt(branch.Attempts, 0)), FanInChildren: diagnosticStringSliceJSON(branch.FanInChildren), LateObservations: pgtype.Int4{Int32: int32(maxInt(branch.LateObservations, 0)), Valid: true}, UnknownReason: diagnosticText(string(branch.UnknownReason))})
	if err != nil {
		return fmt.Errorf("upsert diagnostic branch: %w", err)
	}
	return nil
}

func diagnosticStringSliceJSON(values []string) []byte {
	if values == nil {
		values = []string{}
	}
	return diagnosticBytes(mustJSON(values))
}

func recordProjectionChange(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, cursor int64, ordinal int32, kind episodediagnostics.StreamDeltaKind, entityType, entityID string, payload []byte) error {
	_, err := queries.RecordProjectionChange(ctx, sqlc.RecordProjectionChangeParams{TenantID: tenantID, DiagnosticID: diagnosticID, Cursor: cursor, Ordinal: ordinal, Kind: string(kind), EntityType: diagnosticText(entityType), EntityID: diagnosticText(entityID), Payload: payload})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("record diagnostic projection change: %w", err)
	}
	return nil
}

func optionalUUID(value string) pgtype.UUID {
	if value == "" {
		return pgtype.UUID{}
	}
	return requiredUUID(value)
}

func optionalTimePtr(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return timestamptz(value)
}

func optionalInt64Value(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func optionalInt64ValuePtr(value *int64) pgtype.Int8 {
	if value == nil || *value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}

func maxInt(value, fallback int) int {
	if value < fallback {
		return fallback
	}
	return value
}

func storedIdentifier(value any) pgtype.Text {
	identifier, ok := value.(episodediagnostics.SafeIdentifier)
	if !ok || identifier.Value == "" || !identifier.Copyable {
		return pgtype.Text{}
	}
	return diagnosticText(identifier.Value)
}

func operationLastEvidence(operation episodediagnostics.DiagnosticOperationDetail) int64 {
	var cursor int64
	for _, checkpoint := range operation.Checkpoints {
		if checkpoint.EvidenceCursor > cursor {
			cursor = checkpoint.EvidenceCursor
		}
	}
	return cursor
}

func startDiagnosticLinkedSpan(ctx context.Context, name, traceID, spanID, source, eventName string) (context.Context, trace.Span) {
	links := make([]trace.Link, 0, 1)
	if parsedTraceID, err := trace.TraceIDFromHex(traceID); err == nil {
		if parsedSpanID, spanErr := trace.SpanIDFromHex(spanID); spanErr == nil {
			links = append(links, trace.Link{SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: parsedTraceID, SpanID: parsedSpanID, Remote: true})})
		}
	}
	return diagnosticAdapterTracer.Start(ctx, name,
		trace.WithLinks(links...),
		trace.WithAttributes(
			attribute.String("chalk.diagnostics.event.source", boundedDiagnosticTraceValue(source, 32)),
			attribute.String("chalk.diagnostics.event.name", boundedDiagnosticTraceValue(eventName, 96)),
		),
	)
}

func boundedDiagnosticTraceValue(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func diagnosticOperationIDForEvent(event episodediagnostics.AcceptedDiagnosticEvent) string {
	if event.OperationID != "" {
		return event.OperationID
	}
	key := event.EventID
	if event.ProducerOperationRef != "" {
		key = event.ProducerOperationRef
	}
	digest := sha256.Sum256([]byte("operation|" + key))
	digest[6] = (digest[6] & 0x0f) | 0x50
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", digest[0:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}
