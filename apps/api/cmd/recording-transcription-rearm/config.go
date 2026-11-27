package main

import (
	"context"
	"errors"
	"flag"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingList []string

func (list *recordingList) String() string { return strings.Join(*list, ",") }
func (list *recordingList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("empty recording id")
	}
	*list = append(*list, value)
	return nil
}

type commandOptions struct {
	recordingIDs []utilities.ID
	selected     map[utilities.ID]bool
	batchSize    int
	apply        bool
	cursor       *utilities.ID
	operator     string
	reason       string
	timeout      time.Duration
}

func parseCommandOptions(args []string) (commandOptions, error) {
	flags := flag.NewFlagSet("recording-transcription-rearm", flag.ContinueOnError)
	var explicit recordingList
	flags.Var(&explicit, "recording", "recording UUID to inspect; repeatable")
	batchSize := flags.Int("batch-size", 0, "inspect at most 1-100 expired transcription jobs")
	apply := flags.Bool("apply", false, "re-arm verified recordings; default is a read-only dry run")
	after := flags.String("after-recording", "", "continue batch inventory after the previous report's cursor")
	operator := flags.String("operator", "", "operator identity recorded on each renewal")
	reason := flags.String("reason", "", "operator reason recorded on each renewal")
	limit := flags.Duration("timeout", 15*time.Minute, "whole-command deadline, at most 20 minutes")
	if err := flags.Parse(args); err != nil {
		return commandOptions{}, err
	}
	if err := validateCommandSelection(flags.NArg(), len(explicit), *batchSize, *after, *limit); err != nil {
		return commandOptions{}, err
	}
	if err := validateOperatorArguments(*apply, *operator, *reason); err != nil {
		return commandOptions{}, err
	}
	recordingIDs, selected, err := parseRecordingIDs(explicit)
	if err != nil {
		return commandOptions{}, err
	}
	cursor, err := parseBatchCursor(*after)
	if err != nil {
		return commandOptions{}, err
	}
	return commandOptions{
		recordingIDs: recordingIDs, selected: selected, batchSize: *batchSize, apply: *apply,
		cursor: cursor, operator: *operator, reason: *reason, timeout: *limit,
	}, nil
}

func validateCommandSelection(positional, explicitCount, batchSize int, after string, limit time.Duration) error {
	if positional != 0 || (explicitCount == 0 && batchSize == 0) || batchSize < 0 || batchSize > 100 || limit <= 0 || limit > 20*time.Minute {
		return errors.New("use --recording at least once and/or --batch-size (1-100), with --timeout (0-20m); no positional arguments")
	}
	if after != "" && batchSize == 0 {
		return errors.New("--after-recording requires --batch-size")
	}
	return nil
}

func validateOperatorArguments(apply bool, operator, reason string) error {
	if apply && (strings.TrimSpace(operator) == "" || len(operator) > 256 || strings.TrimSpace(reason) == "" || len(reason) > 1024) {
		return errors.New("--apply requires --operator (1-256 bytes) and --reason (1-1024 bytes)")
	}
	return nil
}

func parseRecordingIDs(explicit recordingList) ([]utilities.ID, map[utilities.ID]bool, error) {
	recordingIDs := make([]utilities.ID, 0, len(explicit))
	seen := map[utilities.ID]bool{}
	for _, value := range explicit {
		id, err := utilities.ParseID(value)
		if err != nil {
			return nil, nil, errors.New("invalid --recording id")
		}
		if !seen[id] {
			seen[id] = true
			recordingIDs = append(recordingIDs, id)
		}
	}
	return recordingIDs, seen, nil
}

func parseBatchCursor(after string) (*utilities.ID, error) {
	if after == "" {
		return nil, nil
	}
	id, err := utilities.ParseID(after)
	if err != nil {
		return nil, errors.New("invalid --after-recording cursor")
	}
	return &id, nil
}

func rearmCommandContext(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc, error) {
	journeyID, err := utilities.NewID()
	if err != nil {
		return ctx, func() {}, errors.New("allocate re-arm journey identity")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	return observability.ContextWithJourneyID(ctx, journeyID), cancel, nil
}

func rearmJourneyID(ctx context.Context) utilities.ID {
	journeyID, _ := observability.JourneyIDFromContext(ctx)
	return journeyID
}
