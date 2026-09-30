package postgres

import (
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"testing"
)

func TestCaptureBundleSchemaPinsFirstAttemptAcrossFlagReload(t *testing.T) {
	for _, testCase := range []struct {
		enabled  bool
		previous *recordingpipeline.RecorderJobEnvelope
		want     string
	}{
		{false, nil, recordingpipeline.LegacyRecordingBundleSchema},
		{true, nil, recordingpipeline.RecordingBundleSchema},
		{true, &recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.LegacyRecordingBundleSchema}, recordingpipeline.LegacyRecordingBundleSchema},
		{false, &recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema}, recordingpipeline.RecordingBundleSchema},
	} {
		if got := captureBundleSchemaVersion(testCase.enabled, testCase.previous); got != testCase.want {
			t.Fatalf("enabled=%t previous=%v: got %q, want %q", testCase.enabled, testCase.previous, got, testCase.want)
		}
	}
}
