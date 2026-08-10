package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	diagnosticProjectorLeaseSeconds = 30
	diagnosticExportLeaseSeconds    = int32(30 * 60)
	diagnosticRetentionClaimSeconds = int32(5 * 60)
)

// EpisodeDiagnosticsRepository is the Postgres adapter for the bounded
// Episode Diagnostic ledger. Writes use appendPool so intake cannot contend
// with viewer queries; projector, query, export, and retention work use the
// query pool.
type EpisodeDiagnosticsRepository struct {
	appendPool *pgxpool.Pool
	queryPool  *pgxpool.Pool
}

func NewEpisodeDiagnosticsRepository(appendPool, queryPool *pgxpool.Pool) *EpisodeDiagnosticsRepository {
	if queryPool == nil {
		queryPool = appendPool
	}
	return &EpisodeDiagnosticsRepository{appendPool: appendPool, queryPool: queryPool}
}

var _ episodediagnostics.Repository = (*EpisodeDiagnosticsRepository)(nil)

// EnsureDiagnosticEnvironmentOwnership claims the database for one
// deployment environment. A second environment fails closed instead of
// sharing global reconciliation, deadline, export, or retention scans.
func (r *EpisodeDiagnosticsRepository) EnsureDiagnosticEnvironmentOwnership(ctx context.Context, environment episodediagnostics.Environment) error {
	if r.queryPool == nil {
		return errDiagnosticsUnavailable
	}
	_, err := sqlc.New(r.queryPool).EnsureDiagnosticEnvironmentOwnership(ctx, string(environment))
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("ensure diagnostic environment ownership: %w", err)
	}
	return nil
}

func (r *EpisodeDiagnosticsRepository) Ensure(ctx context.Context, authoritative episodediagnostics.AuthoritativeEpisode, environment episodediagnostics.Environment) (episodediagnostics.EpisodeDiagnostic, error) {
	if r.appendPool == nil {
		return episodediagnostics.EpisodeDiagnostic{}, errDiagnosticsUnavailable
	}
	episode := authoritative.Episode
	diagnosticID, err := utilities.NewID()
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, fmt.Errorf("generate diagnostic id: %w", err)
	}
	state, endedAt := diagnosticLifecycleForEpisode(episode)
	configSummary, summaryErr := episodediagnostics.SummarizeEpisodeConfig(episode.ConfigSnapshot)
	if summaryErr != nil {
		// Raw Episode policy is never persisted. Keep a valid bounded object even
		// when an older/unknown config shape cannot be summarized.
		configSummary = episodediagnostics.EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}
	}
	config := diagnosticBytes(mustJSON(configSummary))

	var result episodediagnostics.EpisodeDiagnostic
	err = withDiagnosticTx(ctx, r.appendPool, func(tx pgx.Tx) error {
		queries := sqlc.New(tx)
		row, ensureErr := queries.EnsureEpisodeDiagnostic(ctx, sqlc.EnsureEpisodeDiagnosticParams{
			ID:                  uuid(diagnosticID),
			TenantID:            uuid(episode.TenantID),
			SpaceID:             uuid(episode.SpaceID),
			EpisodeID:           uuid(episode.ID),
			Environment:         string(environment),
			State:               state,
			EpisodeStartedAt:    timestamptz(&episode.StartedAt),
			EpisodeEndedAt:      endedAt,
			EpilogueCompletedAt: pgtype.Timestamptz{},
			ExpiresAt:           pgtype.Timestamptz{},
			RunEndCursor:        pgtype.Int8{},
			ConfigSnapshot:      config,
		})
		if ensureErr != nil {
			return fmt.Errorf("ensure episode diagnostic: %w", ensureErr)
		}
		if err := queries.EnsureDiagnosticAuxiliaryRows(ctx, sqlc.EnsureDiagnosticAuxiliaryRowsParams{TenantID: row.TenantID, DiagnosticID: row.ID}); err != nil {
			return fmt.Errorf("ensure diagnostic auxiliary rows: %w", err)
		}
		if err := insertDiagnosticReference(ctx, queries, row.TenantID, row.ID, 0, "", "chalk.episode", episode.ID.String(), "", true, ""); err != nil {
			return fmt.Errorf("ensure diagnostic Episode reference: %w", err)
		}

		// The observer can see the authoritative Episode end after the initial
		// diagnostic row was created. Advance only live rows; a completed or
		// expired diagnostic is immutable from the retention boundary onward.
		if state == string(episodediagnostics.DiagnosticEnded) && row.State == string(episodediagnostics.DiagnosticLive) && endedAt.Valid {
			row, err = queries.UpdateEpisodeDiagnosticLifecycle(ctx, sqlc.UpdateEpisodeDiagnosticLifecycleParams{
				State:               state,
				EpisodeEndedAt:      endedAt,
				EpilogueCompletedAt: pgtype.Timestamptz{},
				ExpiresAt:           pgtype.Timestamptz{},
				RunEndCursor:        pgtype.Int8{},
				TenantID:            row.TenantID,
				DiagnosticID:        row.ID,
			})
			if err != nil {
				return fmt.Errorf("advance diagnostic lifecycle: %w", err)
			}
		}
		result = mapEpisodeDiagnostic(row)
		return nil
	})
	return result, err
}

func (r *EpisodeDiagnosticsRepository) Reconcile(ctx context.Context, environment episodediagnostics.Environment, now time.Time, limit int) ([]episodediagnostics.EpisodeDiagnostic, error) {
	if r.queryPool == nil {
		return nil, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	rows, err := sqlc.New(r.queryPool).ListMissingEpisodeDiagnosticsGlobal(ctx, sqlc.ListMissingEpisodeDiagnosticsGlobalParams{
		NowAt:     timestamptz(&now),
		PageLimit: int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list missing episode diagnostics: %w", err)
	}
	result := make([]episodediagnostics.EpisodeDiagnostic, 0, len(rows))
	for _, row := range rows {
		episode := mapDiagnosticEpisode(row)
		diagnostic, ensureErr := r.Ensure(ctx, episodediagnostics.AuthoritativeEpisode{Episode: episode}, environment)
		if ensureErr != nil {
			return result, ensureErr
		}
		result = append(result, diagnostic)
	}
	referenceRows, referenceErr := sqlc.New(r.queryPool).ListEpisodeDiagnosticsMissingEpisodeReference(ctx, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams{
		Environment: string(environment),
		PageLimit:   int32(limit),
	})
	if referenceErr != nil {
		return result, fmt.Errorf("list diagnostics missing Episode reference: %w", referenceErr)
	}
	for _, row := range referenceRows {
		if err := insertDiagnosticReference(ctx, sqlc.New(r.queryPool), row.TenantID, row.DiagnosticID, 0, "", "chalk.episode", idString(row.EpisodeID), "", true, ""); err != nil {
			return result, fmt.Errorf("backfill diagnostic Episode reference: %w", err)
		}
	}
	// Repair roots whose authoritative Episode ended after the observer created
	// the diagnostic. This path is bounded and does not trust client Events to
	// close the lifecycle.
	driftRows, driftErr := sqlc.New(r.queryPool).ListDiagnosticLifecycleDrift(ctx, sqlc.ListDiagnosticLifecycleDriftParams{Environment: string(environment), PageLimit: int32(limit)})
	if driftErr != nil {
		return result, fmt.Errorf("list diagnostic lifecycle drift: %w", driftErr)
	}
	for _, drift := range driftRows {
		diagnostic := mapEpisodeDiagnostic(sqlc.EpisodeDiagnostic{
			ID: drift.ID, TenantID: drift.TenantID, SpaceID: drift.SpaceID, EpisodeID: drift.EpisodeID,
			Environment: drift.Environment, State: drift.State, EpisodeStartedAt: drift.EpisodeStartedAt,
			EpisodeEndedAt: drift.EpisodeEndedAt, EpilogueCompletedAt: drift.EpilogueCompletedAt, ExpiresAt: drift.ExpiresAt,
			RunEndCursor: drift.RunEndCursor, CommittedCursor: drift.CommittedCursor, ConfigSnapshot: drift.ConfigSnapshot,
		})
		endedAt := timestamp(drift.AuthoritativeEndedAt).UTC()
		if endedAt.IsZero() {
			continue
		}
		diagnostic.EpisodeEndedAt = &endedAt
		if diagnostic.State == episodediagnostics.DiagnosticLive {
			diagnostic.State = episodediagnostics.DiagnosticEnded
		}
		var branchRows []sqlc.DiagnosticBranch
		var branchAfterAt *time.Time
		var branchAfterID pgtype.UUID
		for {
			page, pageErr := sqlc.New(r.queryPool).ListDiagnosticBranchesAfter(ctx, sqlc.ListDiagnosticBranchesAfterParams{TenantID: drift.TenantID, DiagnosticID: drift.ID, AfterCreatedAt: optionalTimePtr(branchAfterAt), AfterID: branchAfterID, PageLimit: 1000})
			if pageErr != nil {
				return result, fmt.Errorf("list diagnostic lifecycle branches: %w", pageErr)
			}
			branchRows = append(branchRows, page...)
			if len(page) < 1000 {
				break
			}
			last := page[len(page)-1]
			lastAt := timestamp(last.CreatedAt).UTC()
			if branchAfterAt != nil && !lastAt.After(*branchAfterAt) && last.ID.Bytes == branchAfterID.Bytes {
				break
			}
			branchAfterAt, branchAfterID = &lastAt, last.ID
		}
		branches := make([]episodediagnostics.DiagnosticBranchDetail, 0, len(branchRows))
		for _, branch := range branchRows {
			branches = append(branches, mapDiagnosticBranch(branch, diagnostic))
		}
		next, updatedBranches, lifecycleErr := episodediagnostics.ReconcileDiagnosticLifecycleObserver(diagnostic, branches, now)
		if lifecycleErr != nil {
			return result, fmt.Errorf("reconcile diagnostic lifecycle: %w", lifecycleErr)
		}
		if err := withDiagnosticTx(ctx, r.queryPool, func(tx pgx.Tx) error {
			queries := sqlc.New(tx)
			for _, branch := range updatedBranches {
				if err := upsertDiagnosticBranch(ctx, queries, drift.TenantID, drift.ID, branch); err != nil {
					return err
				}
			}
			_, err := queries.UpdateEpisodeDiagnosticLifecycle(ctx, sqlc.UpdateEpisodeDiagnosticLifecycleParams{
				State:               string(next.State),
				EpisodeEndedAt:      timestamptz(&endedAt),
				EpilogueCompletedAt: optionalTimePtr(next.EpilogueCompletedAt),
				ExpiresAt:           optionalTimePtr(next.ExpiresAt),
				RunEndCursor:        optionalInt64ValuePtr(next.RunEndCursor),
				TenantID:            drift.TenantID,
				DiagnosticID:        drift.ID,
			})
			return err
		}); err != nil {
			return result, fmt.Errorf("persist diagnostic lifecycle reconciliation: %w", err)
		}
		result = append(result, next)
	}
	return result, nil
}

func (r *EpisodeDiagnosticsRepository) ResolveScope(ctx context.Context, scope episodediagnostics.AppendScope, participantGeneration int64) (episodediagnostics.EpisodeDiagnostic, error) {
	tenantID, err := utilities.ParseID(scope.TenantID)
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrInvalidScope
	}
	spaceID, err := utilities.ParseID(scope.SpaceID)
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrInvalidScope
	}
	episodeID, err := utilities.ParseID(scope.EpisodeID)
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrInvalidScope
	}
	if r.queryPool == nil {
		return episodediagnostics.EpisodeDiagnostic{}, errDiagnosticsUnavailable
	}
	row, err := sqlc.New(r.queryPool).GetEpisodeDiagnosticByEpisode(ctx, sqlc.GetEpisodeDiagnosticByEpisodeParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrNotFound
	}
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, fmt.Errorf("resolve diagnostic scope: %w", err)
	}
	if !row.SpaceID.Valid || row.SpaceID.Bytes != spaceID.Bytes() || row.State == string(episodediagnostics.DiagnosticExpired) {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrNotFound
	}
	if scope.ParticipantID != "" {
		participantID, parseErr := utilities.ParseID(scope.ParticipantID)
		if parseErr != nil || participantGeneration <= 0 {
			return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrForbidden
		}
		participant, participantErr := sqlc.New(r.queryPool).GetDiagnosticParticipant(ctx, sqlc.GetDiagnosticParticipantParams{
			TenantID:      uuid(tenantID),
			SpaceID:       uuid(spaceID),
			EpisodeID:     uuid(episodeID),
			ParticipantID: uuid(participantID),
		})
		if errors.Is(participantErr, pgx.ErrNoRows) {
			return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrForbidden
		}
		if participantErr != nil {
			return episodediagnostics.EpisodeDiagnostic{}, fmt.Errorf("resolve diagnostic participant: %w", participantErr)
		}
		if participant.Generation != participantGeneration || participant.Status != "active" {
			return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrForbidden
		}
	}
	return mapEpisodeDiagnostic(row), nil
}

func (r *EpisodeDiagnosticsRepository) Append(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, participantID *utilities.ID, events []episodediagnostics.ValidatedEvent) (episodediagnostics.AppendDiagnosticEventsResult, error) {
	return r.appendAt(ctx, diagnostic, participantID, events, time.Now().UTC(), false)
}

// appendAt is shared by normal intake and the deadline worker. The worker
// supplies its scan timestamp so synthetic events are deterministic in tests
// and can land exactly on the configured epilogue boundary.
func (r *EpisodeDiagnosticsRepository) appendAt(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, participantID *utilities.ID, events []episodediagnostics.ValidatedEvent, now time.Time, synthetic bool) (episodediagnostics.AppendDiagnosticEventsResult, error) {
	result := episodediagnostics.AppendDiagnosticEventsResult{DiagnosticReference: diagnosticReference(diagnostic)}
	if len(events) == 0 {
		result.CommittedCursor = diagnostic.CommittedCursor
		return result, nil
	}
	if len(events) > episodediagnostics.MaxAppendEvents {
		return result, episodediagnostics.ErrCapacity
	}
	if r.appendPool == nil {
		return result, errDiagnosticsUnavailable
	}

	err := withDiagnosticTx(ctx, r.appendPool, func(tx pgx.Tx) error {
		queries := sqlc.New(tx)
		tenantID, err := utilities.ParseID(diagnostic.TenantID)
		if err != nil {
			return episodediagnostics.ErrNotFound
		}
		diagnosticID, err := utilities.ParseID(diagnostic.ID)
		if err != nil {
			return episodediagnostics.ErrNotFound
		}
		head, err := queries.LockDiagnosticAppendState(ctx, sqlc.LockDiagnosticAppendStateParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodediagnostics.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock diagnostic cursor head: %w", err)
		}

		eventIDs := make([]string, 0, len(events))
		for _, event := range events {
			eventIDs = append(eventIDs, event.Event.EventID)
		}
		existingRows, err := queries.FindEventsByIDs(ctx, sqlc.FindEventsByIDsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), EventIds: eventIDs})
		if err != nil {
			return fmt.Errorf("find diagnostic event ids: %w", err)
		}
		existing := make(map[string]sqlc.DiagnosticEvent, len(existingRows))
		for _, row := range existingRows {
			existing[row.EventID] = row
		}

		now = now.UTC()
		deadlineEvent := synthetic && allSyntheticDeadlineEvents(events)
		if head.Environment != string(diagnostic.Environment) {
			return episodediagnostics.ErrEnvironmentMismatch
		}
		if head.State == string(episodediagnostics.DiagnosticComplete) {
			return episodediagnostics.ErrIntakeClosed
		}
		if head.State == string(episodediagnostics.DiagnosticExpired) || head.ExpiresAt.Valid && !head.ExpiresAt.Time.After(now) {
			return episodediagnostics.ErrDiagnosticExpired
		}
		if head.State == string(episodediagnostics.DiagnosticEnded) && (!head.EpisodeEndedAt.Valid || !head.EpisodeEndedAt.Time.Add(episodediagnostics.MaximumEpilogueLease).After(now)) && !deadlineEvent {
			return episodediagnostics.ErrIntakeClosed
		}
		cursor := head.CommittedCursor
		seen := make(map[string]episodediagnostics.AppendEventReceipt, len(events))
		eventFingerprints := make(map[string]string, len(events))
		duplicateIDs := make([]string, 0, len(events))
		toInsert := make([]appendEventInput, 0, len(events))
		for _, event := range events {
			if priorFingerprint, ok := eventFingerprints[event.Event.EventID]; ok {
				if priorFingerprint == event.Fingerprint {
					duplicateIDs = append(duplicateIDs, event.Event.EventID)
					continue
				}
				result.Conflicts = append(result.Conflicts, episodediagnostics.AppendConflict{EventID: event.Event.EventID, Code: "fingerprint_mismatch"})
				continue
			}
			if row, ok := existing[event.Event.EventID]; ok {
				receipt := episodediagnostics.AppendEventReceipt{EventID: row.EventID, Cursor: row.Cursor}
				seen[event.Event.EventID] = receipt
				eventFingerprints[event.Event.EventID] = row.EventFingerprint
				if row.EventFingerprint == event.Fingerprint {
					result.Duplicates = append(result.Duplicates, receipt)
				} else {
					result.Conflicts = append(result.Conflicts, episodediagnostics.AppendConflict{EventID: event.Event.EventID, Code: "fingerprint_mismatch"})
				}
				continue
			}
			eventFingerprints[event.Event.EventID] = event.Fingerprint
			toInsert = append(toInsert, appendEventInput{event: event, participantID: participantID})
		}

		for _, input := range toInsert {
			if head.EpisodeStartedAt.Valid && input.event.Event.OccurredAt.Before(head.EpisodeStartedAt.Time) || input.event.Event.OccurredAt.After(now) {
				return episodediagnostics.ErrIntakeClosed
			}
			if head.EpisodeEndedAt.Valid && input.event.Event.OccurredAt.After(head.EpisodeEndedAt.Time.Add(episodediagnostics.EndedDiagnosticIntakeGrace)) && !deadlineEvent {
				return episodediagnostics.ErrIntakeClosed
			}
			candidateCursor := cursor + 1
			row, insertErr := queries.InsertDiagnosticEvent(ctx, insertDiagnosticEventParams(tenantID, diagnosticID, candidateCursor, input))
			if errors.Is(insertErr, pgx.ErrNoRows) {
				// A duplicate committed between the initial lookup and insert is
				// harmless; the cursor lock normally makes this unreachable.
				prior, lookupErr := queries.FindEventByID(ctx, sqlc.FindEventByIDParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), EventID: input.event.Event.EventID})
				if lookupErr != nil {
					return fmt.Errorf("resolve concurrent diagnostic event: %w", lookupErr)
				}
				if prior.EventFingerprint != input.event.Fingerprint {
					result.Conflicts = append(result.Conflicts, episodediagnostics.AppendConflict{EventID: input.event.Event.EventID, Code: "fingerprint_mismatch"})
					continue
				}
				receipt := episodediagnostics.AppendEventReceipt{EventID: prior.EventID, Cursor: prior.Cursor}
				seen[input.event.Event.EventID] = receipt
				result.Duplicates = append(result.Duplicates, receipt)
				continue
			}
			if insertErr != nil {
				return fmt.Errorf("insert diagnostic event: %w", insertErr)
			}
			if input.participantID != nil {
				if err := queries.UpsertDiagnosticParticipantProjection(ctx, sqlc.UpsertDiagnosticParticipantProjectionParams{
					TenantID:      uuid(tenantID),
					DiagnosticID:  uuid(diagnosticID),
					ParticipantID: uuid(*input.participantID),
					Cursor:        candidateCursor,
				}); err != nil {
					return fmt.Errorf("upsert diagnostic participant projection: %w", err)
				}
			}
			cursor = candidateCursor
			accepted := mapDiagnosticEventForProjection(row)
			result.Accepted = append(result.Accepted, episodediagnostics.AppendEventReceipt{EventID: accepted.EventID, Cursor: accepted.Cursor})
		}
		acceptedByID := make(map[string]episodediagnostics.AppendEventReceipt, len(result.Accepted)+len(seen))
		for eventID, receipt := range seen {
			acceptedByID[eventID] = receipt
		}
		for _, receipt := range result.Accepted {
			acceptedByID[receipt.EventID] = receipt
		}
		for _, eventID := range duplicateIDs {
			if receipt, ok := acceptedByID[eventID]; ok {
				result.Duplicates = append(result.Duplicates, receipt)
			}
		}

		if len(result.Accepted) > 0 {
			maxCursor := result.Accepted[len(result.Accepted)-1].Cursor
			if _, err := queries.AdvanceDiagnosticCursorHead(ctx, sqlc.AdvanceDiagnosticCursorHeadParams{CommittedCursor: maxCursor, TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID)}); err != nil {
				return fmt.Errorf("advance diagnostic cursor head: %w", err)
			}
			result.CommittedCursor = maxCursor
		} else {
			result.CommittedCursor = head.CommittedCursor
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

type appendEventInput struct {
	event         episodediagnostics.ValidatedEvent
	participantID *utilities.ID
}

func allSyntheticDeadlineEvents(events []episodediagnostics.ValidatedEvent) bool {
	if len(events) == 0 {
		return false
	}
	for _, item := range events {
		event := item.Event
		if event.Source != episodediagnostics.SourceWorker || event.State != episodediagnostics.EventTimedOut || event.Phase != "timed_out" {
			return false
		}
		reason, ok := event.Attributes["reason"].(string)
		if !ok || reason != "deadline" || event.Name != "operation.ended" && event.Name != "checkpoint.missed" && !strings.HasSuffix(event.Name, ".ended") {
			return false
		}
	}
	return true
}

func insertDiagnosticEventParams(tenantID, diagnosticID utilities.ID, cursor int64, input appendEventInput) sqlc.InsertDiagnosticEventParams {
	event := input.event.Event
	params := sqlc.InsertDiagnosticEventParams{
		TenantID:                   uuid(tenantID),
		DiagnosticID:               uuid(diagnosticID),
		Cursor:                     cursor,
		EventID:                    event.EventID,
		EventFingerprint:           input.event.Fingerprint,
		EventVersion:               int16(event.Version),
		OperationID:                optionalUUID(event.OperationID),
		ProducerOperationRef:       diagnosticText(event.ProducerOperationRef),
		ParentProducerOperationRef: diagnosticText(event.ParentProducerOperationRef),
		ParticipantID:              uuidOrZero(input.participantID),
		Source:                     string(event.Source),
		Name:                       event.Name,
		Phase:                      event.Phase,
		State:                      string(event.State),
		OccurredAt:                 timestamptz(&event.OccurredAt),
		ProducerSequence:           event.ProducerSequence,
		SafeAttributes:             diagnosticBytes(mustJSON(event.Attributes)),
	}
	if event.Expectation != nil {
		params.ExpectationName = diagnosticText(event.Expectation.Name)
		params.ExpectationVersion = pgtype.Int4{Int32: int32(event.Expectation.Version), Valid: true}
		params.CheckpointKey = diagnosticText(event.Expectation.Checkpoint)
		params.CheckpointClass = diagnosticText(string(event.Expectation.CheckpointClass))
		params.DeadlineAt = timestamptz(event.Expectation.DeadlineAt)
	}
	if event.Correlation != nil {
		params.JourneyID = diagnosticText(event.Correlation.JourneyID)
		params.TraceID = diagnosticText(event.Correlation.TraceID)
		params.SpanID = diagnosticText(event.Correlation.SpanID)
		params.RequestID = diagnosticText(event.Correlation.RequestID)
		params.CommandID = diagnosticText(event.Correlation.CommandID)
		params.ProviderID = diagnosticText(event.Correlation.ProviderID)
		params.RetryGroupRef = diagnosticText(event.Correlation.RetryGroupRef)
		if event.Correlation.Attempt != 0 {
			params.Attempt = pgtype.Int4{Int32: int32(event.Correlation.Attempt), Valid: true}
		}
	}
	if event.Release != nil {
		params.ReleaseID = diagnosticText(event.Release.ID)
		params.SourceCommit = diagnosticText(event.Release.SourceCommit)
	}
	return params
}

func (r *EpisodeDiagnosticsRepository) Resolve(ctx context.Context, reference episodediagnostics.DiagnosticReference) (episodediagnostics.EpisodeDiagnostic, error) {
	if r.queryPool == nil {
		return episodediagnostics.EpisodeDiagnostic{}, errDiagnosticsUnavailable
	}
	diagnosticID, err := utilities.ParseID(reference.DiagnosticID)
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrNotFound
	}
	row, err := sqlc.New(r.queryPool).GetEpisodeDiagnosticByOpaqueIDGlobal(ctx, uuid(diagnosticID))
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrNotFound
	}
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, fmt.Errorf("resolve diagnostic reference: %w", err)
	}
	if row.Environment != string(reference.Environment) || row.State == string(episodediagnostics.DiagnosticExpired) {
		return episodediagnostics.EpisodeDiagnostic{}, episodediagnostics.ErrNotFound
	}
	return mapEpisodeDiagnostic(row), nil
}

func (r *EpisodeDiagnosticsRepository) ResolveAlternate(ctx context.Context, idClass, lookup, version string) (episodediagnostics.DiagnosticReference, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticReference{}, errDiagnosticsUnavailable
	}
	var rowTenant, rowDiagnostic, rowReference pgtype.UUID
	var environment, state string
	var rawValue, hmacVersion, valueHMAC pgtype.Text
	var eventCursor pgtype.Int8
	var operationID pgtype.UUID
	if version == "" {
		rows, err := sqlc.New(r.queryPool).LookupDiagnosticReferenceRawGlobal(ctx, sqlc.LookupDiagnosticReferenceRawGlobalParams{IDClass: idClass, RawValue: diagnosticText(lookup), PageLimit: 1})
		if err != nil {
			return episodediagnostics.DiagnosticReference{}, fmt.Errorf("lookup diagnostic reference: %w", err)
		}
		if len(rows) == 0 {
			return episodediagnostics.DiagnosticReference{}, episodediagnostics.ErrNotFound
		}
		row := rows[0]
		rowTenant, rowDiagnostic, rowReference, rawValue, hmacVersion, valueHMAC, eventCursor, operationID, environment, state = row.TenantID, row.DiagnosticID, row.ReferenceID, row.RawValue, row.HmacVersion, row.ValueHmac, row.EventCursor, row.OperationID, row.Environment, row.State
	} else {
		rows, err := sqlc.New(r.queryPool).LookupDiagnosticReferenceHMACGlobal(ctx, sqlc.LookupDiagnosticReferenceHMACGlobalParams{IDClass: idClass, HmacVersion: diagnosticText(version), ValueHmac: diagnosticText(lookup), PageLimit: 1})
		if err != nil {
			return episodediagnostics.DiagnosticReference{}, fmt.Errorf("lookup diagnostic HMAC reference: %w", err)
		}
		if len(rows) == 0 {
			return episodediagnostics.DiagnosticReference{}, episodediagnostics.ErrNotFound
		}
		row := rows[0]
		rowTenant, rowDiagnostic, rowReference, rawValue, hmacVersion, valueHMAC, eventCursor, operationID, environment, state = row.TenantID, row.DiagnosticID, row.ReferenceID, row.RawValue, row.HmacVersion, row.ValueHmac, row.EventCursor, row.OperationID, row.Environment, row.State
	}
	if state == string(episodediagnostics.DiagnosticExpired) {
		return episodediagnostics.DiagnosticReference{}, episodediagnostics.ErrNotFound
	}
	parsedDiagnosticID := utilities.IDFromBytes(rowDiagnostic.Bytes)
	result := episodediagnostics.DiagnosticReference{Version: episodediagnostics.ContractVersion, Environment: episodediagnostics.Environment(environment), DiagnosticID: parsedDiagnosticID.String()}
	if operationID.Valid {
		operationOpaqueID := utilities.IDFromBytes(operationID.Bytes).String()
		result.Focus = &episodediagnostics.DiagnosticReferenceFocus{Kind: episodediagnostics.ReferenceFocusOperation, ID: operationOpaqueID}
	} else if eventCursor.Valid {
		cursor := eventCursor.Int64
		result.Focus = &episodediagnostics.DiagnosticReferenceFocus{Kind: episodediagnostics.ReferenceFocusEvent, ID: strconv.FormatInt(cursor, 10)}
		result.Cursor = &cursor
	}
	_ = rowTenant
	_ = rowReference
	_ = rawValue
	_ = hmacVersion
	_ = valueHMAC
	return result, nil
}

func (r *EpisodeDiagnosticsRepository) ReadSnapshot(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, filter episodediagnostics.DiagnosticFilterV1, limit int) (episodediagnostics.DiagnosticSnapshotV1, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticSnapshotV1{}, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.MaxSnapshotOperations
	}
	queries := sqlc.New(r.queryPool)
	if err := episodediagnostics.ValidateFilter(filter); err != nil {
		return episodediagnostics.DiagnosticSnapshotV1{}, err
	}
	state, counts, err := r.loadProjectionState(ctx, queries, diagnostic, filter, limit, episodediagnostics.MaxSnapshotIssues, episodediagnostics.MaxSnapshotBranches)
	if err != nil {
		return episodediagnostics.DiagnosticSnapshotV1{}, err
	}
	snapshot := state.Snapshot(diagnosticReference(diagnostic), time.Now().UTC())
	snapshot.Summary.EventCount = counts.eventCount
	snapshot.Summary.OperationCount = counts.operationCount
	snapshot.Summary.IssueCount = counts.issueCount
	snapshot.Summary.OpenIssueCount = counts.openIssueCount
	snapshot.Summary.ParticipantCount = counts.participantCount
	snapshot.CommittedCursor = counts.committedCursor
	snapshot.ProjectedCursor = counts.projectedCursor
	snapshot.RunEndCursor = diagnosticNullableInt64Ptr(counts.runEndCursor)
	if diagnosticFilterPresent(filter) {
		participant, parseErr := parseOptionalID(filter.ParticipantID)
		if parseErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, parseErr
		}
		filteredCount, countErr := queries.CountDiagnosticEventsFiltered(ctx, sqlc.CountDiagnosticEventsFilteredParams{
			TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), ParticipantID: participant,
			FromCursor: diagnosticOptionalInt8(filter.FromCursor), ToCursor: diagnosticOptionalInt8(filter.ToCursor),
			Source: diagnosticText(string(filter.Source)), OperationKind: diagnosticText(filter.OperationKind), State: diagnosticText(filter.State),
			ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime),
		})
		if countErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, fmt.Errorf("count filtered diagnostic events: %w", countErr)
		}
		operationCount, operationCountErr := queries.CountDiagnosticOperationsFiltered(ctx, sqlc.CountDiagnosticOperationsFilteredParams{TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), OperationKind: diagnosticText(filter.OperationKind), State: diagnosticText(filter.State), Source: diagnosticText(string(filter.Source)), ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime)})
		if operationCountErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, fmt.Errorf("count filtered diagnostic operations: %w", operationCountErr)
		}
		issueCounts, issueCountErr := queries.CountDiagnosticIssuesFiltered(ctx, sqlc.CountDiagnosticIssuesFilteredParams{TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), ParticipantID: participant, IssueState: diagnosticText(string(filter.IssueState)), OperationKind: diagnosticText(filter.OperationKind), Source: diagnosticText(string(filter.Source)), ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime)})
		if issueCountErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, fmt.Errorf("count filtered diagnostic issues: %w", issueCountErr)
		}
		branchCount, branchCountErr := queries.CountDiagnosticBranchesFiltered(ctx, sqlc.CountDiagnosticBranchesFilteredParams{TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), ParticipantID: participant, OperationKind: diagnosticText(filter.OperationKind), State: diagnosticText(filter.State), Source: diagnosticText(string(filter.Source)), ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime)})
		if branchCountErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, fmt.Errorf("count filtered diagnostic branches: %w", branchCountErr)
		}
		participantCount, participantCountErr := queries.CountDiagnosticParticipantsFiltered(ctx, sqlc.CountDiagnosticParticipantsFilteredParams{TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), ParticipantID: participant, FromCursor: diagnosticOptionalInt8(filter.FromCursor), ToCursor: diagnosticOptionalInt8(filter.ToCursor), Source: diagnosticText(string(filter.Source)), OperationKind: diagnosticText(filter.OperationKind), State: diagnosticText(filter.State), ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime)})
		if participantCountErr != nil {
			return episodediagnostics.DiagnosticSnapshotV1{}, fmt.Errorf("count filtered diagnostic participants: %w", participantCountErr)
		}
		snapshot.Summary.EventCount = filteredCount
		snapshot.Summary.OperationCount = operationCount
		snapshot.Summary.IssueCount = issueCounts.IssueCount
		snapshot.Summary.ParticipantCount = participantCount
		snapshot.Summary.OpenIssueCount = issueCounts.OpenIssueCount
		if branchCount > int64(len(snapshot.Branches)) {
			snapshot.Omissions = append(snapshot.Omissions, "branches_truncated")
		}
	}
	if !diagnosticFilterPresent(filter) && counts.operationCount > int64(len(snapshot.Operations)) {
		snapshot.Omissions = append(snapshot.Omissions, "operations_truncated")
	}
	if !diagnosticFilterPresent(filter) && counts.issueCount > int64(len(snapshot.Issues)) {
		snapshot.Omissions = append(snapshot.Omissions, "issues_truncated")
	}
	if !diagnosticFilterPresent(filter) && counts.branchCount > int64(len(snapshot.Branches)) {
		snapshot.Omissions = append(snapshot.Omissions, "branches_truncated")
	}
	return snapshot, nil
}

func (r *EpisodeDiagnosticsRepository) PageEvents(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, filter episodediagnostics.DiagnosticFilterV1, after, before *int64, limit int) (episodediagnostics.DiagnosticEventPageV1, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticEventPageV1{}, errDiagnosticsUnavailable
	}
	if err := episodediagnostics.ValidateFilter(filter); err != nil {
		return episodediagnostics.DiagnosticEventPageV1{}, err
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	afterValue, beforeValue := optionalCursor(after), optionalCursor(before)
	if afterValue == nil && filter.FromCursor != nil {
		value := *filter.FromCursor - 1
		afterValue = optionalCursor(&value)
	}
	if beforeValue == nil && filter.ToCursor != nil && *filter.ToCursor < episodediagnostics.MaxCursor {
		value := *filter.ToCursor + 1
		beforeValue = optionalCursor(&value)
	}
	participant, err := parseOptionalID(filter.ParticipantID)
	if err != nil {
		return episodediagnostics.DiagnosticEventPageV1{}, err
	}
	rows, err := sqlc.New(r.queryPool).PageEvents(ctx, sqlc.PageEventsParams{
		TenantID:      requiredUUID(diagnostic.TenantID),
		DiagnosticID:  requiredUUID(diagnostic.ID),
		AfterCursor:   diagnosticOptionalInt8(afterValue),
		BeforeCursor:  diagnosticOptionalInt8(beforeValue),
		ParticipantID: participant,
		Source:        diagnosticText(string(filter.Source)),
		OperationKind: diagnosticText(filter.OperationKind),
		State:         diagnosticText(filter.State),
		ReleaseID:     diagnosticText(filter.ReleaseID),
		RequestID:     diagnosticText(filter.RequestID),
		CommandID:     diagnosticText(filter.CommandID),
		ProviderID:    diagnosticText(filter.ProviderID),
		JourneyID:     diagnosticText(filter.JourneyID),
		TraceID:       diagnosticText(filter.TraceID),
		SpanID:        diagnosticText(filter.SpanID),
		FromTime:      optionalTime(filter.FromTime),
		ToTime:        optionalTime(filter.ToTime),
		PageLimit:     int32(limit + 1),
	})
	if err != nil {
		return episodediagnostics.DiagnosticEventPageV1{}, fmt.Errorf("page diagnostic events: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	events := make([]episodediagnostics.AcceptedDiagnosticEvent, 0, len(rows))
	for _, row := range rows {
		events = append(events, mapDiagnosticEventForOperator(row))
	}
	committed, projected := r.diagnosticCursors(ctx, diagnostic, sqlc.New(r.queryPool))
	page := episodediagnostics.DiagnosticEventPageV1{SchemaVersion: "DiagnosticEventPage/v1", Reference: diagnosticReference(diagnostic), Events: events, CommittedCursor: committed, ProjectedCursor: projected, AfterCursor: after, BeforeCursor: before, HasMore: hasMore, FilterFingerprint: episodediagnostics.FilterFingerprint(filter)}
	if hasMore && len(events) > 0 {
		cursor := events[len(events)-1].Cursor
		page.NextCursor = &cursor
	}
	return page, nil
}

func (r *EpisodeDiagnosticsRepository) PageOperations(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, filter episodediagnostics.DiagnosticFilterV1, after *int64, limit int) (episodediagnostics.DiagnosticOperationPageV1, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticOperationPageV1{}, errDiagnosticsUnavailable
	}
	if err := episodediagnostics.ValidateFilter(filter); err != nil {
		return episodediagnostics.DiagnosticOperationPageV1{}, err
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	rows, err := sqlc.New(r.queryPool).ListDiagnosticOperations(ctx, listDiagnosticOperationsParams(diagnostic, filter, after, int32(limit+1)))
	if err != nil {
		return episodediagnostics.DiagnosticOperationPageV1{}, fmt.Errorf("page diagnostic operations: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	operations := make([]episodediagnostics.DiagnosticOperationDetail, 0, len(rows))
	queries := sqlc.New(r.queryPool)
	for _, row := range rows {
		detail := mapDiagnosticOperation(row, diagnostic)
		checkpoints, checkpointErr := queries.ListDiagnosticCheckpoints(ctx, sqlc.ListDiagnosticCheckpointsParams{TenantID: row.TenantID, DiagnosticID: row.DiagnosticID, OperationID: row.ID})
		if checkpointErr != nil {
			return episodediagnostics.DiagnosticOperationPageV1{}, fmt.Errorf("list diagnostic checkpoints: %w", checkpointErr)
		}
		for _, checkpoint := range checkpoints {
			detail.Checkpoints = append(detail.Checkpoints, mapDiagnosticCheckpoint(checkpoint))
		}
		operations = append(operations, detail)
	}
	committed, projected := r.diagnosticCursors(ctx, diagnostic, queries)
	page := episodediagnostics.DiagnosticOperationPageV1{SchemaVersion: "DiagnosticOperationPage/v1", Reference: diagnosticReference(diagnostic), Operations: operations, CommittedCursor: committed, ProjectedCursor: projected, HasMore: hasMore, FilterFingerprint: episodediagnostics.FilterFingerprint(filter)}
	if hasMore {
		cursor := rows[len(rows)-1].FirstEvidenceCursor
		if cursor <= 0 && rows[len(rows)-1].LastEvidenceCursor.Valid {
			cursor = rows[len(rows)-1].LastEvidenceCursor.Int64
		}
		page.NextCursor = &cursor
	}
	return page, nil
}

func (r *EpisodeDiagnosticsRepository) ListProjectionChanges(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, after int64, limit int) ([]episodediagnostics.ProjectionChange, error) {
	if r.queryPool == nil {
		return nil, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return nil, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil {
		return nil, episodediagnostics.ErrNotFound
	}
	rows, err := sqlc.New(r.queryPool).ListProjectionChangesAfterCursor(ctx, sqlc.ListProjectionChangesAfterCursorParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), AfterCursor: after, PageLimit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list diagnostic projection changes: %w", err)
	}
	changes := make([]episodediagnostics.ProjectionChange, 0, len(rows))
	for _, row := range rows {
		changes = append(changes, episodediagnostics.ProjectionChange{Cursor: row.Cursor, Ordinal: int(row.Ordinal), Kind: episodediagnostics.StreamDeltaKind(row.Kind), Payload: append(json.RawMessage(nil), row.Payload...)})
	}
	return changes, nil
}

type snapshotCounts struct {
	committedCursor  int64
	projectedCursor  int64
	runEndCursor     pgtype.Int8
	eventCount       int64
	operationCount   int64
	issueCount       int64
	openIssueCount   int64
	participantCount int64
	branchCount      int64
}

func (r *EpisodeDiagnosticsRepository) loadProjectionState(ctx context.Context, queries *sqlc.Queries, diagnostic episodediagnostics.EpisodeDiagnostic, filter episodediagnostics.DiagnosticFilterV1, operationLimit, issueLimit, branchLimit int, targetedOperationIDs ...[]string) (episodediagnostics.ProjectionState, snapshotCounts, error) {
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return episodediagnostics.ProjectionState{}, snapshotCounts{}, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil {
		return episodediagnostics.ProjectionState{}, snapshotCounts{}, episodediagnostics.ErrNotFound
	}
	row, err := queries.GetDiagnosticSnapshot(ctx, sqlc.GetDiagnosticSnapshotParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.ProjectionState{}, snapshotCounts{}, episodediagnostics.ErrNotFound
	}
	if err != nil {
		return episodediagnostics.ProjectionState{}, snapshotCounts{}, fmt.Errorf("get diagnostic snapshot: %w", err)
	}
	root := mapEpisodeDiagnosticSnapshot(row)
	state := episodediagnostics.NewProjectionState(root)
	state.Events = make(map[string]episodediagnostics.AcceptedDiagnosticEvent)
	counts := snapshotCounts{committedCursor: row.CommittedCursor, projectedCursor: row.ProjectedCursor, runEndCursor: row.RunEndCursor, eventCount: row.EventCount, operationCount: row.OperationCount, issueCount: row.IssueCount, openIssueCount: row.OpenIssueCount, participantCount: row.ParticipantCount, branchCount: row.BranchCount}
	participantFilter, participantErr := parseOptionalID(filter.ParticipantID)
	if participantErr != nil {
		return state, counts, participantErr
	}
	participants, participantErr := queries.ListDiagnosticParticipants(ctx, sqlc.ListDiagnosticParticipantsParams{PageLimit: int32(minInt(branchLimit, 100)), TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), ParticipantID: participantFilter})
	if participantErr != nil {
		return state, counts, fmt.Errorf("list diagnostic participants: %w", participantErr)
	}
	for _, participant := range participants {
		mapped := mapDiagnosticParticipant(participant)
		state.Participants[mapped.ParticipantID] = mapped
	}
	var operations []sqlc.DiagnosticOperation
	var targetIDs []string
	if len(targetedOperationIDs) > 0 {
		targetIDs = targetedOperationIDs[0]
	}
	if len(targetIDs) > 0 {
		operationUUIDs := diagnosticUUIDs(targetIDs)
		if len(operationUUIDs) > 0 {
			operations, err = queries.ListDiagnosticOperationsByIDs(ctx, sqlc.ListDiagnosticOperationsByIDsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), OperationIds: operationUUIDs})
		}
		if err != nil {
			return state, counts, fmt.Errorf("list targeted diagnostic operations: %w", err)
		}
		// Parent operation state is required to resolve producer references while
		// reducing a child event; pull the bounded dependency closure as well.
		for depth := 0; depth < 4; depth++ {
			known := make(map[[16]byte]struct{}, len(operations))
			parents := make([]pgtype.UUID, 0)
			for _, operation := range operations {
				known[operation.ID.Bytes] = struct{}{}
			}
			for _, operation := range operations {
				if operation.ParentID.Valid {
					if _, exists := known[operation.ParentID.Bytes]; !exists {
						parents = append(parents, operation.ParentID)
					}
				}
			}
			if len(parents) == 0 {
				break
			}
			parentRows, parentErr := queries.ListDiagnosticOperationsByIDs(ctx, sqlc.ListDiagnosticOperationsByIDsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), OperationIds: parents})
			if parentErr != nil {
				return state, counts, fmt.Errorf("list targeted parent operations: %w", parentErr)
			}
			operations = append(operations, parentRows...)
		}
	} else if operationLimit <= 0 {
		var after *int64
		for {
			page, pageErr := queries.ListDiagnosticOperations(ctx, listDiagnosticOperationsParams(root, filter, after, 1000))
			if pageErr != nil {
				return state, counts, fmt.Errorf("list diagnostic operations: %w", pageErr)
			}
			operations = append(operations, page...)
			if len(page) < 1000 {
				break
			}
			last := page[len(page)-1].FirstEvidenceCursor
			if after != nil && last <= *after {
				break
			}
			after = &last
		}
	} else {
		operations, err = queries.ListDiagnosticOperations(ctx, listDiagnosticOperationsParams(root, filter, nil, int32(operationLimit)))
		if err != nil {
			return state, counts, fmt.Errorf("list diagnostic operations: %w", err)
		}
	}
	for _, row := range operations {
		detail := mapDiagnosticOperation(row, root)
		checkpoints, checkpointErr := queries.ListDiagnosticCheckpoints(ctx, sqlc.ListDiagnosticCheckpointsParams{TenantID: row.TenantID, DiagnosticID: row.DiagnosticID, OperationID: row.ID})
		if checkpointErr != nil {
			return state, counts, fmt.Errorf("list diagnostic checkpoints: %w", checkpointErr)
		}
		for _, checkpoint := range checkpoints {
			detail.Checkpoints = append(detail.Checkpoints, mapDiagnosticCheckpoint(checkpoint))
		}
		state.Operations[detail.ID] = detail
		if value := nullableText(row.ProducerOperationRef); value != nil {
			state.OperationRefs[*value] = detail.ID
		}
		if value := nullableText(row.ParentProducerOperationRef); value != nil {
			state.ParentRefs[detail.ID] = *value
		}
	}
	if len(targetIDs) > 0 {
		targetIDs = targetIDs[:0]
		for _, operation := range operations {
			targetIDs = append(targetIDs, idString(operation.ID))
		}
	}
	issueState := pgtype.Text{}
	if filter.IssueState != "" {
		issueState = diagnosticText(string(filter.IssueState))
	}
	var issues []sqlc.DiagnosticIssue
	if len(targetIDs) > 0 {
		operationUUIDs := diagnosticUUIDs(targetIDs)
		if len(operationUUIDs) > 0 {
			issues, err = queries.ListDiagnosticIssuesByOperationIDs(ctx, sqlc.ListDiagnosticIssuesByOperationIDsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), OperationIds: operationUUIDs})
		}
		if err != nil {
			return state, counts, fmt.Errorf("list targeted diagnostic issues: %w", err)
		}
	} else if issueLimit <= 0 {
		var afterAt *time.Time
		var afterID pgtype.UUID
		for {
			page, pageErr := queries.ListDiagnosticIssuesAfter(ctx, sqlc.ListDiagnosticIssuesAfterParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), State: issueState, AfterObservedAt: optionalTimePtr(afterAt), AfterIssueID: afterID, PageLimit: 1000})
			if pageErr != nil {
				return state, counts, fmt.Errorf("list diagnostic issues: %w", pageErr)
			}
			issues = append(issues, page...)
			if len(page) < 1000 {
				break
			}
			last := page[len(page)-1]
			lastAt := timestamp(last.FirstObservedAt).UTC()
			if afterAt != nil && !lastAt.After(*afterAt) && last.ID.Bytes == afterID.Bytes {
				break
			}
			afterAt, afterID = &lastAt, last.ID
		}
	} else {
		issues, err = queries.ListDiagnosticIssues(ctx, sqlc.ListDiagnosticIssuesParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), State: issueState, PageLimit: int32(issueLimit)})
		if err != nil {
			return state, counts, fmt.Errorf("list diagnostic issues: %w", err)
		}
	}
	for _, row := range issues {
		issue := mapDiagnosticIssue(row, root)
		state.Issues[issue.ID] = issue
	}
	branches, err := queries.ListDiagnosticBranches(ctx, sqlc.ListDiagnosticBranchesParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), PageLimit: int32(branchLimit)})
	if err != nil {
		return state, counts, fmt.Errorf("list diagnostic branches: %w", err)
	}
	for _, row := range branches {
		branch := mapDiagnosticBranch(row, root)
		state.Branches[branch.ID] = branch
	}
	if diagnosticFilterPresent(filter) {
		// Issues and branches are projections of filtered operations. Keep the
		// entity sets congruent with the event/operation predicate.
		for id, issue := range state.Issues {
			if issue.OperationID != "" {
				if _, ok := state.Operations[issue.OperationID]; !ok {
					delete(state.Issues, id)
				}
			}
		}
		branchIDs := make(map[string]struct{})
		for _, operation := range state.Operations {
			if operation.BranchID != "" {
				branchIDs[operation.BranchID] = struct{}{}
			}
		}
		for id := range state.Branches {
			if _, ok := branchIDs[id]; !ok {
				delete(state.Branches, id)
			}
		}
		// The materialized participant table is bounded; use indexed event
		// existence checks to honor every event filter without ledger scans.
		for id := range state.Participants {
			participantFilter := filter
			participantFilter.ParticipantID = id
			participantID, parseErr := parseOptionalID(id)
			if parseErr != nil {
				delete(state.Participants, id)
				continue
			}
			participantAfter, participantBefore := diagnosticFilterCursors(participantFilter)
			eventRows, pageErr := queries.PageEvents(ctx, sqlc.PageEventsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), AfterCursor: diagnosticOptionalInt8(participantAfter), BeforeCursor: diagnosticOptionalInt8(participantBefore), ParticipantID: participantID, Source: diagnosticText(string(participantFilter.Source)), OperationKind: diagnosticText(participantFilter.OperationKind), State: diagnosticText(participantFilter.State), ReleaseID: diagnosticText(participantFilter.ReleaseID), RequestID: diagnosticText(participantFilter.RequestID), CommandID: diagnosticText(participantFilter.CommandID), ProviderID: diagnosticText(participantFilter.ProviderID), JourneyID: diagnosticText(participantFilter.JourneyID), TraceID: diagnosticText(participantFilter.TraceID), SpanID: diagnosticText(participantFilter.SpanID), FromTime: optionalTime(participantFilter.FromTime), ToTime: optionalTime(participantFilter.ToTime), PageLimit: 1})
			if pageErr != nil || len(eventRows) == 0 {
				delete(state.Participants, id)
			}
		}
	}
	return state, counts, nil
}

func diagnosticFilterPresent(filter episodediagnostics.DiagnosticFilterV1) bool {
	return filter.ParticipantID != "" || filter.Source != "" || filter.OperationKind != "" || filter.State != "" || filter.IssueState != "" || filter.ReleaseID != "" || filter.JourneyID != "" || filter.TraceID != "" || filter.SpanID != "" || filter.RequestID != "" || filter.CommandID != "" || filter.ProviderID != "" || filter.FromCursor != nil || filter.ToCursor != nil || !filter.FromTime.IsZero() || !filter.ToTime.IsZero()
}

func diagnosticFilterCursors(filter episodediagnostics.DiagnosticFilterV1) (*int64, *int64) {
	var after, before *int64
	if filter.FromCursor != nil {
		value := *filter.FromCursor - 1
		after = &value
	}
	if filter.ToCursor != nil && *filter.ToCursor < episodediagnostics.MaxCursor {
		value := *filter.ToCursor + 1
		before = &value
	}
	return after, before
}

func diagnosticUUIDs(values []string) []pgtype.UUID {
	result := make([]pgtype.UUID, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		parsed, err := utilities.ParseID(value)
		if err != nil {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, uuid(parsed))
	}
	return result
}

func listDiagnosticOperationsParams(diagnostic episodediagnostics.EpisodeDiagnostic, filter episodediagnostics.DiagnosticFilterV1, afterEvidenceCursor *int64, pageLimit int32) sqlc.ListDiagnosticOperationsParams {
	params := sqlc.ListDiagnosticOperationsParams{TenantID: requiredUUID(diagnostic.TenantID), DiagnosticID: requiredUUID(diagnostic.ID), OperationKind: diagnosticText(filter.OperationKind), State: diagnosticText(filter.State), Source: diagnosticText(string(filter.Source)), ReleaseID: diagnosticText(filter.ReleaseID), RequestID: diagnosticText(filter.RequestID), CommandID: diagnosticText(filter.CommandID), ProviderID: diagnosticText(filter.ProviderID), JourneyID: diagnosticText(filter.JourneyID), TraceID: diagnosticText(filter.TraceID), SpanID: diagnosticText(filter.SpanID), FromTime: optionalTime(filter.FromTime), ToTime: optionalTime(filter.ToTime), PageLimit: pageLimit}
	if afterEvidenceCursor != nil {
		params.AfterEvidenceCursor = diagnosticOptionalInt8(afterEvidenceCursor)
	}
	return params
}

func mapEpisodeDiagnostic(row sqlc.EpisodeDiagnostic) episodediagnostics.EpisodeDiagnostic {
	return episodediagnostics.EpisodeDiagnostic{SchemaVersion: "EpisodeDiagnostic/v1", ID: idString(row.ID), TenantID: idString(row.TenantID), SpaceID: idString(row.SpaceID), EpisodeID: idString(row.EpisodeID), Environment: episodediagnostics.Environment(row.Environment), State: episodediagnostics.DiagnosticState(row.State), EpisodeStartedAt: timestamp(row.EpisodeStartedAt).UTC(), EpisodeEndedAt: nullableTimestampUTC(row.EpisodeEndedAt), EpilogueCompletedAt: nullableTimestampUTC(row.EpilogueCompletedAt), ExpiresAt: nullableTimestampUTC(row.ExpiresAt), RunEndCursor: diagnosticNullableInt64Ptr(row.RunEndCursor), CommittedCursor: row.CommittedCursor, ConfigSummary: diagnosticConfigSummary(row.ConfigSnapshot)}
}

func mapEpisodeDiagnosticSnapshot(row sqlc.GetDiagnosticSnapshotRow) episodediagnostics.EpisodeDiagnostic {
	return episodediagnostics.EpisodeDiagnostic{SchemaVersion: "EpisodeDiagnostic/v1", ID: idString(row.ID), TenantID: idString(row.TenantID), SpaceID: idString(row.SpaceID), EpisodeID: idString(row.EpisodeID), Environment: episodediagnostics.Environment(row.Environment), State: episodediagnostics.DiagnosticState(row.State), EpisodeStartedAt: timestamp(row.EpisodeStartedAt).UTC(), EpisodeEndedAt: nullableTimestampUTC(row.EpisodeEndedAt), EpilogueCompletedAt: nullableTimestampUTC(row.EpilogueCompletedAt), ExpiresAt: nullableTimestampUTC(row.ExpiresAt), RunEndCursor: diagnosticNullableInt64Ptr(row.RunEndCursor), CommittedCursor: row.CommittedCursor, ProjectedCursor: row.ProjectedCursor, ConfigSummary: diagnosticConfigSummary(row.ConfigSnapshot)}
}

func diagnosticConfigSummary(raw []byte) *episodediagnostics.EpisodeConfigSummaryV1 {
	var persisted episodediagnostics.EpisodeConfigSummaryV1
	if err := json.Unmarshal(raw, &persisted); err == nil && persisted.SchemaVersion == "EpisodeConfigSummary/v1" && persisted.RoleCount >= 0 && persisted.RoleCount <= episodediagnostics.MaxConfigRoles && persisted.CapabilityCount >= 0 && persisted.CapabilityCount <= episodediagnostics.MaxConfigCapabilities && persisted.DefaultEpisodeDurationSeconds >= 0 && persisted.MaximumEpisodeDurationSeconds >= 0 && persisted.LingerWindowSeconds >= 0 {
		return &persisted
	}
	summary, err := episodediagnostics.SummarizeEpisodeConfig(raw)
	if err != nil {
		summary = episodediagnostics.EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}
	}
	return &summary
}

func mapDiagnosticEvent(row sqlc.DiagnosticEvent, exposeProvider bool) episodediagnostics.AcceptedDiagnosticEvent {
	draft := episodediagnostics.DiagnosticEventDraft{Version: int(row.EventVersion), EventID: row.EventID, OperationID: idStringOrEmpty(row.OperationID), ParticipantID: idStringOrEmpty(row.ParticipantID), ProducerOperationRef: nullableString(row.ProducerOperationRef), ParentProducerOperationRef: nullableString(row.ParentProducerOperationRef), ProducerSequence: row.ProducerSequence, OccurredAt: timestamp(row.OccurredAt).UTC(), Source: episodediagnostics.EventSource(row.Source), Name: row.Name, Phase: row.Phase, State: episodediagnostics.EventState(row.State), Attributes: decodeAttributes(row.SafeAttributes)}
	if row.ExpectationName.Valid {
		draft.Expectation = &episodediagnostics.DiagnosticEventExpectation{Name: row.ExpectationName.String, Version: int(row.ExpectationVersion.Int32), Checkpoint: row.CheckpointKey.String, CheckpointClass: episodediagnostics.CheckpointClass(row.CheckpointClass.String), DeadlineAt: nullableTimestampUTC(row.DeadlineAt)}
	}
	if correlationPresent(row, exposeProvider) {
		draft.Correlation = &episodediagnostics.DiagnosticEventCorrelation{JourneyID: nullableString(row.JourneyID), TraceID: nullableString(row.TraceID), SpanID: nullableString(row.SpanID), RequestID: nullableString(row.RequestID), CommandID: nullableString(row.CommandID), ProviderID: providerValue(row.ProviderID, exposeProvider), RetryGroupRef: nullableString(row.RetryGroupRef), Attempt: int64(row.Attempt.Int32)}
	}
	if row.ReleaseID.Valid {
		draft.Release = &episodediagnostics.DiagnosticRelease{ID: row.ReleaseID.String, SourceCommit: nullableString(row.SourceCommit)}
	}
	return episodediagnostics.AcceptedDiagnosticEvent{DiagnosticEventDraft: draft, DiagnosticID: idString(row.DiagnosticID), Cursor: row.Cursor, ReceivedAt: timestamp(row.ReceivedAt).UTC(), Fingerprint: row.EventFingerprint}
}

// mapDiagnosticEventForProjection retains the stored provider HMAC only while
// reducing an internal projection. It must never be used for an operator
// response or an exported artifact.
func mapDiagnosticEventForProjection(row sqlc.DiagnosticEvent) episodediagnostics.AcceptedDiagnosticEvent {
	return mapDiagnosticEvent(row, true)
}

// mapDiagnosticEventForOperator is the public boundary mapper. Provider IDs
// are HMAC-only storage values, so the operator contract receives an explicit
// omission while indexed filtering continues to use the stored HMAC.
func mapDiagnosticEventForOperator(row sqlc.DiagnosticEvent) episodediagnostics.AcceptedDiagnosticEvent {
	return mapDiagnosticEvent(row, false)
}

func mapDiagnosticOperation(row sqlc.DiagnosticOperation, diagnostic episodediagnostics.EpisodeDiagnostic) episodediagnostics.DiagnosticOperationDetail {
	detail := episodediagnostics.DiagnosticOperationDetail{SchemaVersion: "OperationDetail/v1", ID: idString(row.ID), ParentID: idStringOrEmpty(row.ParentID), BranchID: idStringOrEmpty(row.BranchID), Kind: row.Kind, ExpectationVersion: int(row.ExpectationVersion), State: episodediagnostics.OperationState(row.State), Attempt: int(row.Attempt), StartedAt: timestamp(row.StartedAt).UTC(), FirstEvidenceCursor: row.FirstEvidenceCursor, DeadlineAt: nullableTimestampUTC(row.DeadlineAt), GraceEndsAt: nullableTimestampUTC(row.GraceEndsAt), EndedAt: nullableTimestampUTC(row.EndedAt), ErrorClass: nullableString(row.ErrorClass), Source: episodediagnostics.EventSource(row.Source), ReleaseID: nullableString(row.ReleaseID), SourceCommit: nullableString(row.SourceCommit), ClockUncertainty: nullableString(row.ClockUncertainty), VisibilityGaps: decodeStringSlice(row.VisibilityGaps)}
	detail.ProviderLookupID = nullableString(row.ProviderID)
	if value := nullableText(row.ProducerOperationRef); value != nil {
		detail.Reference = valueString(value)
	}
	detail.DiagnosticReference = diagnosticReference(diagnostic)
	detail.RetryGroup = episodediagnostics.SafeIdentifierFor("chalk.retry", nullableString(row.RetryGroupRef))
	detail.RequestID = episodediagnostics.SafeIdentifierFor("chalk.request", nullableString(row.RequestID))
	detail.CommandID = episodediagnostics.SafeIdentifierFor("chalk.command", nullableString(row.CommandID))
	detail.ProviderID = episodediagnostics.SafeIdentifierFor("provider", nullableString(row.ProviderID))
	detail.JourneyID = episodediagnostics.SafeIdentifierFor("chalk.journey", nullableString(row.JourneyID))
	detail.TraceID = episodediagnostics.SafeIdentifierFor("w3c.trace", nullableString(row.TraceID))
	detail.SpanID = episodediagnostics.SafeIdentifierFor("w3c.span", nullableString(row.SpanID))
	detail.DurationMilliseconds = operationDuration(detail.StartedAt, detail.EndedAt)
	if detail.ID != "" {
		if reference, err := episodediagnostics.FormatReference(episodediagnostics.DiagnosticReference{Version: episodediagnostics.ContractVersion, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID, Focus: &episodediagnostics.DiagnosticReferenceFocus{Kind: episodediagnostics.ReferenceFocusOperation, ID: detail.ID}}); err == nil {
			detail.Reference = reference
		}
	}
	return detail
}

func mapDiagnosticCheckpoint(row sqlc.DiagnosticCheckpoint) episodediagnostics.DiagnosticCheckpointDetail {
	return episodediagnostics.DiagnosticCheckpointDetail{Key: row.CheckpointKey, Class: episodediagnostics.CheckpointClass(row.Class), DisplayOrder: int(row.DisplayOrder), State: episodediagnostics.CheckpointState(row.State), DeadlineAt: nullableTimestampUTC(row.DeadlineAt), EvidenceCursor: nullableInt64(row.EvidenceCursor), UnknownReason: episodediagnostics.UnknownReason(nullableString(row.UnknownReason)), Predicate: nullableString(row.Predicate)}
}

func mapDiagnosticIssue(row sqlc.DiagnosticIssue, diagnostic episodediagnostics.EpisodeDiagnostic) episodediagnostics.DiagnosticIssueDetail {
	detail := episodediagnostics.DiagnosticIssueDetail{SchemaVersion: "IssueDetail/v1", ID: idString(row.ID), OperationID: idStringOrEmpty(row.OperationID), Kind: row.Kind, Severity: episodediagnostics.IssueSeverity(row.Severity), State: episodediagnostics.IssueState(row.State), Summary: row.Summary, FirstObservedAt: timestamp(row.FirstObservedAt).UTC(), LastObservedAt: nullableTimestampUTC(row.LastObservedAt), ResolvedAt: nullableTimestampUTC(row.ResolvedAt), LastConfirmedCheckpoint: nullableString(row.LastConfirmedCheckpoint), MissingCheckpoint: nullableString(row.MissingCheckpoint), RetryState: nullableString(row.RetryState), UnknownReason: episodediagnostics.UnknownReason(nullableString(row.UnknownReason)), DiagnosticReference: diagnosticReference(diagnostic)}
	if row.AffectedKind.Valid {
		detail.Affected = &episodediagnostics.DiagnosticAffectedSubject{Kind: row.AffectedKind.String, Identifier: projectedSafeIdentifier(nullableString(row.AffectedIDClass), nullableString(row.AffectedIDValue))}
	}
	if detail.ID != "" {
		if reference, err := episodediagnostics.FormatReference(episodediagnostics.DiagnosticReference{Version: episodediagnostics.ContractVersion, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID, Focus: &episodediagnostics.DiagnosticReferenceFocus{Kind: episodediagnostics.ReferenceFocusIssue, ID: detail.ID}}); err == nil {
			detail.Reference = reference
		}
	}
	return detail
}

func mapDiagnosticBranch(row sqlc.DiagnosticBranch, _ episodediagnostics.EpisodeDiagnostic) episodediagnostics.DiagnosticBranchDetail {
	return episodediagnostics.DiagnosticBranchDetail{SchemaVersion: "BranchDetail/v1", ID: idString(row.ID), Kind: episodediagnostics.BranchKind(row.Kind), State: episodediagnostics.BranchState(row.State), LeaseEndsAt: timestamp(row.LeaseEndsAt).UTC(), StartedAt: nullableTimestampUTC(row.StartedAt), TerminalAt: nullableTimestampUTC(row.TerminalAt), TerminalCursor: nullableInt64(row.TerminalCursor), Attempts: int(row.Attempts), FanInChildren: decodeStringSlice(row.FanInChildren), UnknownReason: episodediagnostics.UnknownReason(nullableString(row.UnknownReason))}
}

func mapDiagnosticParticipant(row sqlc.ListDiagnosticParticipantsRow) episodediagnostics.ParticipantProjectionV1 {
	participantID := idString(row.ParticipantID)
	state := "active"
	if row.LatestLifecycleName == "participant.leave" {
		state = "left"
	} else if row.LatestLifecycleName == "" {
		state = "unknown"
	}
	label := "participant-"
	if len(participantID) >= 8 {
		label += participantID[:8]
	} else {
		label += "unknown"
	}
	return episodediagnostics.ParticipantProjectionV1{
		SchemaVersion:  "ParticipantProjection/v1",
		ParticipantID:  participantID,
		AnonymousLabel: label,
		IdentityKind:   "anonymous",
		State:          state,
		JoinedAt:       nullableTimestampUTC(row.JoinedAt),
		LeftAt:         nullableTimestampUTC(row.LeftAt),
		Visibility:     "opaque",
		VisibilityGaps: []string{"identity_redacted"},
		OperationCount: row.OperationCount,
		IssueCount:     row.IssueCount,
		Display: episodediagnostics.ParticipantDisplay{
			Label:       episodediagnostics.DisplayValue{Value: label},
			RawIdentity: episodediagnostics.DisplayValue{UnknownReason: episodediagnostics.UnknownRedacted},
		},
	}
}

func mapDiagnosticParticipantAfter(row sqlc.ListDiagnosticParticipantsAfterRow) episodediagnostics.ParticipantProjectionV1 {
	return mapDiagnosticParticipant(sqlc.ListDiagnosticParticipantsRow(row))
}

func diagnosticLifecycleForEpisode(episode episodes.Episode) (string, pgtype.Timestamptz) {
	if episode.Status == episodes.EpisodeStatusEnded || episode.Status == episodes.EpisodeStatusEnding || !episode.EndedAt.IsZero() {
		return string(episodediagnostics.DiagnosticEnded), timestamptz(nonZeroTimePtr(episode.EndedAt))
	}
	return string(episodediagnostics.DiagnosticLive), pgtype.Timestamptz{}
}

func diagnosticReference(diagnostic episodediagnostics.EpisodeDiagnostic) string {
	value, err := episodediagnostics.FormatReference(episodediagnostics.DiagnosticReference{Version: episodediagnostics.ContractVersion, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID})
	if err != nil {
		return ""
	}
	return value
}

func mapDiagnosticEpisode(row sqlc.Episode) episodes.Episode {
	return episodes.Episode{ID: utilities.IDFromBytes(row.ID.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), Status: row.Status, Metadata: jsonRaw(row.Metadata), ConfigSnapshot: jsonRaw(row.ConfigSnapshot), EndReason: nullableText(row.EndReason), StartedAt: timestamp(row.StartedAt), EndedAt: timestamp(row.EndedAt), DeadlineAt: timestamp(row.DeadlineAt), DeadlineGeneration: row.DeadlineGeneration, UpdatedAt: timestamp(row.UpdatedAt), CreatedAt: timestamp(row.CreatedAt)}
}

var errDiagnosticsUnavailable = errors.New("episode diagnostics database unavailable")

func withDiagnosticTx(ctx context.Context, pool *pgxpool.Pool, work func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin diagnostics transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit diagnostics transaction: %w", err)
	}
	return nil
}

func diagnosticText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func optionalTime(value time.Time) pgtype.Timestamptz {
	if value.IsZero() {
		return pgtype.Timestamptz{}
	}
	return timestamptz(&value)
}

func optionalCursor(value *int64) *int64 { return value }

func diagnosticOptionalInt8(value *int64) pgtype.Int8 {
	if value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}

func parseOptionalID(value string) (pgtype.UUID, error) {
	if value == "" {
		return pgtype.UUID{}, nil
	}
	id, err := utilities.ParseID(value)
	if err != nil {
		return pgtype.UUID{}, episodediagnostics.ErrInvalidScope
	}
	return uuid(id), nil
}

func requiredUUID(value string) pgtype.UUID {
	id, _ := utilities.ParseID(value)
	return uuid(id)
}

func uuidOrZero(value *utilities.ID) pgtype.UUID {
	if value == nil {
		return pgtype.UUID{}
	}
	return uuid(*value)
}

func nullableTimestampUTC(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func diagnosticNullableInt64Ptr(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}

func idString(value pgtype.UUID) string {
	if !value.Valid {
		return ""
	}
	return utilities.IDFromBytes(value.Bytes).String()
}

func idStringOrEmpty(value pgtype.UUID) string { return idString(value) }

func nullableString(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func decodeAttributes(value []byte) episodediagnostics.DiagnosticAttributes {
	result := episodediagnostics.DiagnosticAttributes{}
	if len(value) == 0 || json.Unmarshal(value, &result) != nil || result == nil {
		return result
	}
	return result
}

func decodeStringSlice(value []byte) []string {
	var result []string
	if len(value) == 0 || json.Unmarshal(value, &result) != nil {
		return nil
	}
	return result
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}

func diagnosticBytes(value []byte) []byte { return append([]byte(nil), value...) }

func providerValue(value pgtype.Text, expose bool) string {
	if !expose || !value.Valid {
		return ""
	}
	return value.String
}

func correlationPresent(row sqlc.DiagnosticEvent, exposeProvider bool) bool {
	return row.JourneyID.Valid || row.TraceID.Valid || row.SpanID.Valid || row.RequestID.Valid || row.CommandID.Valid || (exposeProvider && row.ProviderID.Valid) || row.RetryGroupRef.Valid || row.Attempt.Valid
}

func projectedSafeIdentifier(idClass, value string) episodediagnostics.SafeIdentifier {
	identifier, ok := episodediagnostics.SafeIdentifierFor(idClass, value).(episodediagnostics.SafeIdentifier)
	if ok && episodediagnostics.ValidateSafeIdentifier(identifier) == nil {
		return identifier
	}
	fallback := episodediagnostics.SafeIdentifier{IDClass: idClass, Copyable: false, UnknownReason: episodediagnostics.UnknownInvalid}
	if episodediagnostics.ValidateSafeIdentifier(fallback) == nil {
		return fallback
	}
	return episodediagnostics.SafeIdentifier{IDClass: "unknown", Copyable: false, UnknownReason: episodediagnostics.UnknownProviderOpaque}
}

func operationDuration(start time.Time, end *time.Time) int64 {
	if end == nil || start.IsZero() || end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}

func nonZeroTimePtr(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

func valueString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func (r *EpisodeDiagnosticsRepository) diagnosticCursors(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, queries *sqlc.Queries) (int64, int64) {
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return diagnostic.CommittedCursor, diagnostic.ProjectedCursor
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil {
		return diagnostic.CommittedCursor, diagnostic.ProjectedCursor
	}
	row, err := queries.GetDiagnosticSnapshot(ctx, sqlc.GetDiagnosticSnapshotParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID)})
	if err != nil {
		return diagnostic.CommittedCursor, diagnostic.ProjectedCursor
	}
	return row.CommittedCursor, row.ProjectedCursor
}

// Keep deterministic import use when build tags omit projection files.
