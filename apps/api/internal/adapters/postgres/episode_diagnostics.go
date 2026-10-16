package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"

	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	diagnosticRetentionClaimSeconds = int32(5 * 60)
)

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
		next, updatedBranches, lifecycleErr := episodediagnostics.ReconcileDiagnosticLifecycle(diagnostic, branches, now)
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
	return r.appendAt(ctx, diagnostic, participantID, events, time.Now().UTC())
}

func (r *EpisodeDiagnosticsRepository) appendAt(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, participantID *utilities.ID, events []episodediagnostics.ValidatedEvent, now time.Time) (episodediagnostics.AppendDiagnosticEventsResult, error) {
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
		if head.Environment != string(diagnostic.Environment) {
			return episodediagnostics.ErrEnvironmentMismatch
		}
		if head.State == string(episodediagnostics.DiagnosticComplete) {
			return episodediagnostics.ErrIntakeClosed
		}
		if head.State == string(episodediagnostics.DiagnosticExpired) || head.ExpiresAt.Valid && !head.ExpiresAt.Time.After(now) {
			return episodediagnostics.ErrDiagnosticExpired
		}
		if head.State == string(episodediagnostics.DiagnosticEnded) && (!head.EpisodeEndedAt.Valid || !head.EpisodeEndedAt.Time.Add(episodediagnostics.MaximumEpilogueLease).After(now)) {
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
			if head.EpisodeEndedAt.Valid && input.event.Event.OccurredAt.After(head.EpisodeEndedAt.Time.Add(episodediagnostics.EndedDiagnosticIntakeGrace)) {
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
			cursor = candidateCursor
			result.Accepted = append(result.Accepted, episodediagnostics.AppendEventReceipt{EventID: row.EventID, Cursor: row.Cursor})
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

func mapEpisodeDiagnostic(row sqlc.EpisodeDiagnostic) episodediagnostics.EpisodeDiagnostic {
	return episodediagnostics.EpisodeDiagnostic{SchemaVersion: "EpisodeDiagnostic/v1", ID: idString(row.ID), TenantID: idString(row.TenantID), SpaceID: idString(row.SpaceID), EpisodeID: idString(row.EpisodeID), Environment: episodediagnostics.Environment(row.Environment), State: episodediagnostics.DiagnosticState(row.State), EpisodeStartedAt: timestamp(row.EpisodeStartedAt).UTC(), EpisodeEndedAt: nullableTimestampUTC(row.EpisodeEndedAt), EpilogueCompletedAt: nullableTimestampUTC(row.EpilogueCompletedAt), ExpiresAt: nullableTimestampUTC(row.ExpiresAt), RunEndCursor: diagnosticNullableInt64Ptr(row.RunEndCursor), CommittedCursor: row.CommittedCursor, ConfigSummary: diagnosticConfigSummary(row.ConfigSnapshot)}
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

func mapDiagnosticBranch(row sqlc.DiagnosticBranch, _ episodediagnostics.EpisodeDiagnostic) episodediagnostics.DiagnosticBranchDetail {
	return episodediagnostics.DiagnosticBranchDetail{SchemaVersion: "BranchDetail/v1", ID: idString(row.ID), Kind: episodediagnostics.BranchKind(row.Kind), State: episodediagnostics.BranchState(row.State), LeaseEndsAt: timestamp(row.LeaseEndsAt).UTC(), StartedAt: nullableTimestampUTC(row.StartedAt), TerminalAt: nullableTimestampUTC(row.TerminalAt), TerminalCursor: nullableInt64(row.TerminalCursor), Attempts: int(row.Attempts), FanInChildren: decodeStringSlice(row.FanInChildren), UnknownReason: episodediagnostics.UnknownReason(nullableString(row.UnknownReason))}
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

func nullableString(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
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

func nonZeroTimePtr(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

func requiredUUID(value string) pgtype.UUID { id, _ := utilities.ParseID(value); return uuid(id) }
