package httpapi

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestExportDegradationLogIsOneBoundedIdentifierFreeEvent(t *testing.T) {
	var output bytes.Buffer
	logger := observability.New(observability.Config{LogFormat: observability.LogFormatJSON}, &output).Logger()
	sources := make([]recordingpipeline.VideoDegradation, 20)
	for i := range sources {
		sources[i] = recordingpipeline.VideoDegradation{SourceID: "source-identity-not-for-logs", Kind: "camera", FrozenMS: 1000, DroppedFrames: 30, Recoveries: 1}
	}
	logExportDegradation(logger, "job", sources)
	if strings.Count(output.String(), "\n") != 1 || strings.Contains(output.String(), "source-identity-not-for-logs") || strings.Contains(output.String(), "source_id") || strings.Contains(output.String(), "journey_id") || strings.Contains(output.String(), "trace_id") || strings.Contains(output.String(), "span_id") {
		t.Fatalf("unbounded or identifying log: %s", output.String())
	}
	var event struct {
		Message         string `json:"msg"`
		JobID           string `json:"job_id"`
		DegradedSources int    `json:"degraded_sources"`
		FrozenMS        int64  `json:"frozen_ms"`
		OmittedSources  int    `json:"omitted_sources"`
		Sources         []struct {
			SourceIndex   int   `json:"source_index"`
			FrozenMS      int64 `json:"frozen_ms"`
			DroppedFrames int   `json:"dropped_frames"`
			Recoveries    int   `json:"recoveries"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.Message != "recording.export.degraded" || event.JobID != "job" || event.DegradedSources != 20 || event.FrozenMS != 20000 || len(event.Sources) != 16 || event.OmittedSources != 4 || event.Sources[15].SourceIndex != 15 || event.Sources[0].DroppedFrames != 30 || event.Sources[0].Recoveries != 1 {
		t.Fatalf("quality counters: %+v", event)
	}
	output.Reset()
	logExportDegradation(logger, "job", []recordingpipeline.VideoDegradation{{Kind: "camera"}})
	if output.Len() != 0 {
		t.Fatalf("clean Export logged as degraded: %s", output.String())
	}
}
