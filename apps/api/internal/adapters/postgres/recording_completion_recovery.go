package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

// RequestCompletionRecovery grants one completion-only claim without resetting
// the automatic attempt budget or replacing the failed authority history.
func (r RecordingPipelineRepository) RequestCompletionRecovery(ctx context.Context, input recordingpipeline.CompletionRecoveryInput, objects recordingpipeline.CompletionRecoveryObjects) error {
	ctx, span := otel.Tracer("chalk/recordingpipeline").Start(ctx, "recording.completion.recovery.request")
	defer span.End()
	outcome, reason := "rejected", "not_eligible"
	defer func() {
		span.SetAttributes(attribute.String("outcome", outcome), attribute.String("reason", reason))
		slog.InfoContext(ctx, "Recording completion recovery request", "event", "recording.completion.recovery.request", "outcome", outcome, "reason", reason, "request_id", input.RequestID.String(), "recording_id", input.RecordingID.String())
	}()
	if input.TenantID.IsZero() || input.RecordingID.IsZero() || input.RequestID.IsZero() ||
		strings.TrimSpace(input.Operator) == "" || len(input.Operator) > 256 ||
		strings.TrimSpace(input.Reason) == "" || len(input.Reason) > 1024 || objects == nil {
		return recordingpipeline.ErrCompletionRecoveryUnavailable
	}
	err := r.transaction(ctx, func(tx pgx.Tx, _ recordingPipelineQuerier) error {
		queries := sqlc.New(tx)
		// A separate locking statement ensures duplicate requests see the committed
		// grant, including requests that were blocked on the first transaction.
		if _, err := queries.LockRecordingCompletionRecovery(ctx, sqlc.LockRecordingCompletionRecoveryParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)}); err != nil {
			return err
		}
		existing, err := queries.GetRecordingCompletionRecovery(ctx, sqlc.GetRecordingCompletionRecoveryParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
		if err == nil {
			if existing.RequestID == uuid(input.RequestID) && existing.Operator == input.Operator && existing.Reason == input.Reason {
				outcome, reason = "replayed", "same_request"
				return nil
			}
			reason = "already_requested"
			return recordingpipeline.ErrCompletionRecoveryAlreadyRequested
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		candidate, err := queries.GetRecordingCompletionRecoveryCandidate(ctx, sqlc.GetRecordingCompletionRecoveryCandidateParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
		if err != nil {
			return err
		}
		bundles, err := queries.ListRecordingCompletionRecoveryBundles(ctx, sqlc.ListRecordingCompletionRecoveryBundlesParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
		if err != nil {
			return err
		}
		if len(bundles) == 0 {
			reason = "source_missing"
			return recordingpipeline.ErrCompletionRecoveryUnavailable
		}
		for _, bundle := range bundles {
			facts, err := objects.InspectObject(ctx, bundle.ObjectKey)
			if err != nil {
				reason = "source_inspection_failed"
				return fmt.Errorf("inspect Recording recovery source: %w: %w", recordingpipeline.ErrCompletionRecoveryUnavailable, err)
			}
			checksum, err := objectstorage.ObjectSHA256(facts)
			if err != nil || facts.Size != bundle.ByteSize || !bytes.Equal(checksum, bundle.Checksum) {
				reason = "source_facts_mismatch"
				return recordingpipeline.ErrCompletionRecoveryUnavailable
			}
		}
		_, err = queries.RequestRecordingCompletionRecovery(ctx, sqlc.RequestRecordingCompletionRecoveryParams{
			JobID: candidate.ID, RequestID: uuid(input.RequestID), Operator: input.Operator, Reason: input.Reason, SourceExpiresAt: candidate.SourceExpiresAt,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.ErrCompletionRecoveryUnavailable
	}
	if err != nil {
		return fmt.Errorf("request Recording completion recovery: %w", err)
	}
	if outcome != "replayed" {
		outcome, reason = "accepted", "queued"
	}
	return nil
}
