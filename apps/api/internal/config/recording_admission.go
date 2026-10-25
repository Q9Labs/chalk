package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

const RecordingAdmissionCap = "CHALK_RECORDING_ADMISSION_CAP"
const RecordingParticipantCap = "CHALK_RECORDING_PARTICIPANT_CAP"

func loadRecordingAdmission() (recordingpipeline.AdmissionLimits, error) {
	limits := (recordingpipeline.AdmissionLimits{}).WithDefaults()
	for _, setting := range []struct {
		name    string
		maximum int
		target  *int
	}{
		{RecordingAdmissionCap, 20, &limits.RecordingCap},
		{RecordingParticipantCap, 200, &limits.ParticipantCap},
	} {
		raw := strings.TrimSpace(os.Getenv(setting.name))
		if raw == "" {
			continue
		}
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > setting.maximum {
			return recordingpipeline.AdmissionLimits{}, fmt.Errorf("%s must be between 1 and %d", setting.name, setting.maximum)
		}
		*setting.target = value
	}
	return limits, nil
}
