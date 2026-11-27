package main

import (
	"encoding/json"
	"io"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingOutcome struct {
	RecordingID     string `json:"recording_id"`
	JobID           string `json:"job_id,omitempty"`
	Outcome         string `json:"outcome"`
	SourceExpiresAt string `json:"source_expires_at,omitempty"`
}

type report struct {
	DryRun           bool               `json:"dry_run"`
	Inspected        int                `json:"inspected"`
	Eligible         int                `json:"eligible"`
	Rearmed          int                `json:"rearmed"`
	AlreadyRearmed   int                `json:"already_rearmed"`
	Completed        int                `json:"completed"`
	NotEligible      int                `json:"not_eligible"`
	MissingSource    int                `json:"missing_source"`
	Unverifiable     int                `json:"unverifiable"`
	NoLongerEligible int                `json:"no_longer_eligible"`
	NextAfter        string             `json:"next_after_recording,omitempty"`
	Recordings       []recordingOutcome `json:"recordings"`
}

func recordMissingRecordings(result *report, missing []utilities.ID) {
	for _, recordingID := range missing {
		result.add(recordingOutcome{RecordingID: recordingID.String(), Outcome: "not_found"})
	}
}

func (result *report) add(outcome recordingOutcome) {
	result.Inspected++
	result.Recordings = append(result.Recordings, outcome)
	switch outcome.Outcome {
	case "eligible":
		result.Eligible++
	case "rearmed":
		result.Rearmed++
	case "already_rearmed":
		result.AlreadyRearmed++
	case "completed":
		result.Completed++
	case "missing_source":
		result.MissingSource++
	case "unverifiable":
		result.Unverifiable++
	case "no_longer_eligible":
		result.NoLongerEligible++
	default:
		result.NotEligible++
	}
}

func writeReport(out io.Writer, result report) error {
	return json.NewEncoder(out).Encode(result)
}
