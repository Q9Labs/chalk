package main

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func processInventory(ctx context.Context, resources commandResources, options commandOptions, inventory inventoryResult, result *report) error {
	for _, candidate := range inventory.candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		if inventory.batchIDs[candidate.RecordingID] {
			result.NextAfter = candidate.RecordingID.String()
		}
		outcome, err := processCandidate(ctx, resources, options, candidate)
		if err != nil {
			return err
		}
		result.add(outcome)
	}
	return nil
}

func processCandidate(ctx context.Context, resources commandResources, options commandOptions, candidate recordingpipeline.TranscriptionRearmCandidate) (recordingOutcome, error) {
	outcome := recordingOutcome{RecordingID: candidate.RecordingID.String(), JobID: candidate.JobID.String()}
	if refusal := recordingpipeline.TranscriptionRearmRefusal(candidate, time.Now().UTC()); refusal != "" {
		outcome.Outcome = refusal
		return outcome, nil
	}
	if sourceOutcome := sourceVerificationOutcome(ctx, resources, candidate.ObjectKeys); sourceOutcome != "" {
		outcome.Outcome = sourceOutcome
		return outcome, nil
	}
	if !options.apply {
		outcome.Outcome = "eligible"
		return outcome, nil
	}
	return applyCandidate(ctx, resources, options, candidate, outcome)
}
