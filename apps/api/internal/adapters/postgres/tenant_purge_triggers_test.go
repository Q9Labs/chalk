package postgres

import "testing"

func TestPurgeAppendOnlyGuardsCoverRecordingRecoveryAudits(t *testing.T) {
	for trigger, function := range map[string]string{
		"recording_completion_recoveries_immutable":         "reject_recording_completion_recovery_mutation",
		"recording_transcription_source_renewals_immutable": "reject_recording_transcription_source_renewal_mutation",
	} {
		if purgeAppendOnlyGuards[trigger] != function {
			t.Fatalf("purge guard %q = %q, want %q", trigger, purgeAppendOnlyGuards[trigger], function)
		}
	}
}
