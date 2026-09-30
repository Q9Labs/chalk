package recordingdecode

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestBundleAuthorityRejectsSchemaAndKeyHandleMismatch(t *testing.T) {
	const (
		recordingID = "recording-1"
		episodeID   = "episode-1"
		tenantID    = "tenant-1"
		jobID       = "job-1"
		digest      = "digest-1"
		handle      = "key-1"
	)
	request := Request{RecordingID: recordingID, EpisodeID: episodeID, TenantID: tenantID, Environment: "test", DurationMS: 100}
	file := BundleFile{Sequence: 1, CaptureEpoch: 2, CaptureJobID: jobID, RecorderEnvelopeDigest: digest, BundleSchema: recordingbundle.Version, KeyHandle: handle}
	bundle := recordingbundle.Bundle{Version: recordingbundle.Version, Manifest: recordingbundle.Manifest{RecordingID: recordingID, CaptureEpoch: 2, Sequence: 1, RecorderEnvelopeDigest: digest, MediaRange: recordingbundle.TimeRange{EndMilliseconds: 50}, Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID, BundleSchema: recordingbundle.Version, KeyHandle: handle}}}
	if err := validateBundleAuthority(request, file, bundle); err != nil {
		t.Fatalf("matching signed authority: %v", err)
	}
	for _, testCase := range []struct {
		name   string
		mutate func(*BundleFile, *recordingbundle.Bundle)
	}{
		{"signed schema", func(file *BundleFile, _ *recordingbundle.Bundle) { file.BundleSchema = recordingbundle.LegacyVersion }},
		{"plaintext schema", func(_ *BundleFile, bundle *recordingbundle.Bundle) {
			bundle.Manifest.Encryption.BundleSchema = recordingbundle.LegacyVersion
		}},
		{"signed key handle", func(file *BundleFile, _ *recordingbundle.Bundle) { file.KeyHandle = "different-key" }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			alteredFile, alteredBundle := file, bundle
			testCase.mutate(&alteredFile, &alteredBundle)
			if err := validateBundleAuthority(request, alteredFile, alteredBundle); !errors.Is(err, ErrInvalidBundle) {
				t.Fatalf("authority mismatch error = %v", err)
			}
		})
	}
}
