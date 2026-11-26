package main

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type inventoryResult struct {
	candidates []recordingpipeline.TranscriptionRearmCandidate
	missing    []utilities.ID
	batchIDs   map[utilities.ID]bool
}

func loadInventory(ctx context.Context, repository postgres.RecordingPipelineRepository, options commandOptions) (inventoryResult, error) {
	candidates, missing, err := loadExplicitCandidates(ctx, repository, options.recordingIDs)
	if err != nil {
		return inventoryResult{}, err
	}
	batchCandidates, batchIDs, err := loadBatchCandidates(ctx, repository, options)
	if err != nil {
		return inventoryResult{}, err
	}
	return inventoryResult{candidates: append(candidates, batchCandidates...), missing: missing, batchIDs: batchIDs}, nil
}

func loadExplicitCandidates(ctx context.Context, repository postgres.RecordingPipelineRepository, recordingIDs []utilities.ID) ([]recordingpipeline.TranscriptionRearmCandidate, []utilities.ID, error) {
	candidates := make([]recordingpipeline.TranscriptionRearmCandidate, 0, len(recordingIDs))
	missing := []utilities.ID{}
	for _, recordingID := range recordingIDs {
		candidate, err := repository.GetTranscriptionRearmCandidate(ctx, recordingID)
		if errors.Is(err, recordingpipeline.ErrJobNotFound) {
			missing = append(missing, recordingID)
			continue
		}
		if err != nil {
			return nil, nil, databaseFailure("inspect transcription re-arm recording", err)
		}
		candidates = append(candidates, candidate)
	}
	return candidates, missing, nil
}

func loadBatchCandidates(ctx context.Context, repository postgres.RecordingPipelineRepository, options commandOptions) ([]recordingpipeline.TranscriptionRearmCandidate, map[utilities.ID]bool, error) {
	batchIDs := map[utilities.ID]bool{}
	if options.batchSize == 0 {
		return nil, batchIDs, nil
	}
	listed, err := repository.ListTranscriptionRearmCandidates(ctx, options.cursor, options.batchSize)
	if err != nil {
		return nil, nil, databaseFailure("inventory transcription re-arm candidates", err)
	}
	candidates := make([]recordingpipeline.TranscriptionRearmCandidate, 0, len(listed))
	for _, candidate := range listed {
		if options.selected[candidate.RecordingID] {
			continue
		}
		batchIDs[candidate.RecordingID] = true
		candidates = append(candidates, candidate)
	}
	return candidates, batchIDs, nil
}
