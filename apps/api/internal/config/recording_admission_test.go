package config

import (
	"strings"
	"testing"
)

func TestRecordingAdmissionConfiguration(t *testing.T) {
	for _, tc := range []struct {
		recordings, participants         string
		wantRecordings, wantParticipants int
		invalid                          string
	}{
		{"", "", 10, 100, ""}, {"20", "200", 20, 200, ""}, {"1", "1", 1, 1, ""},
		{"0", "100", 0, 0, RecordingAdmissionCap}, {"21", "100", 0, 0, RecordingAdmissionCap},
		{"no", "100", 0, 0, RecordingAdmissionCap}, {"10", "0", 0, 0, RecordingParticipantCap},
		{"10", "201", 0, 0, RecordingParticipantCap}, {"10", "no", 0, 0, RecordingParticipantCap},
	} {
		t.Run(tc.recordings+"/"+tc.participants, func(t *testing.T) {
			t.Setenv(RecordingAdmissionCap, tc.recordings)
			t.Setenv(RecordingParticipantCap, tc.participants)
			limits, err := loadRecordingAdmission()
			if tc.invalid != "" {
				if err == nil || !strings.Contains(err.Error(), tc.invalid) {
					t.Fatalf("named limit error = %v", err)
				}
				if _, err := Load(); err == nil || !strings.Contains(err.Error(), tc.invalid) {
					t.Fatalf("startup error = %v", err)
				}
				return
			}
			if err != nil || limits.RecordingCap != tc.wantRecordings || limits.ParticipantCap != tc.wantParticipants || limits.BitrateCapBPS() != int64(tc.wantRecordings)*4_000_000 {
				t.Fatalf("limits = %+v, %v", limits, err)
			}
		})
	}
}
