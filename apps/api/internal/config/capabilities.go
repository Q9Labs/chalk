package config

const (
	RecordingEnabled         = "CHALK_RECORDING_ENABLED"
	RecordingBundleV2Enabled = "CHALK_RECORDING_BUNDLE_V2_ENABLED"
	TranscriptionEnabled     = "CHALK_TRANSCRIPTION_ENABLED"
	WhiteboardFilesEnabled   = "CHALK_WHITEBOARD_FILES_ENABLED"
)

type CapabilityConfig struct {
	Recording       bool
	Transcription   bool
	WhiteboardFiles bool
}

func loadCapabilityConfig(environment string) (CapabilityConfig, error) {
	defaultEnabled := environment != DefaultEnvironment
	transcription, err := envStrictBool(TranscriptionEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	recording, err := envStrictBool(RecordingEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	whiteboardFiles, err := envStrictBool(WhiteboardFilesEnabled, false)
	if err != nil {
		return CapabilityConfig{}, err
	}
	return CapabilityConfig{Recording: recording, Transcription: transcription, WhiteboardFiles: whiteboardFiles}, nil
}
