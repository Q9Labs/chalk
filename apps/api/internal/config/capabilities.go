package config

const (
	RecordingEnabled         = "CHALK_RECORDING_ENABLED"
	RecordingBundleV2Enabled = "CHALK_RECORDING_BUNDLE_V2_ENABLED"
	TranscriptionEnabled     = "CHALK_TRANSCRIPTION_ENABLED"
	WhiteboardFilesEnabled   = "CHALK_WHITEBOARD_FILES_ENABLED"
	ScreenAnnotationEnabled  = "CHALK_SCREEN_ANNOTATION_ENABLED"
	PresentingEnabled        = "CHALK_PRESENTING_ENABLED"
)

type CapabilityConfig struct {
	Recording        bool
	Transcription    bool
	WhiteboardFiles  bool
	ScreenAnnotation bool
	Presenting       bool
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
	screenAnnotation, err := envStrictBool(ScreenAnnotationEnabled, defaultScreenAnnotation(environment))
	if err != nil {
		return CapabilityConfig{}, err
	}
	presenting, err := envStrictBool(PresentingEnabled, defaultScreenAnnotation(environment))
	if err != nil {
		return CapabilityConfig{}, err
	}
	return CapabilityConfig{
		Recording: recording, Transcription: transcription, WhiteboardFiles: whiteboardFiles,
		ScreenAnnotation: screenAnnotation, Presenting: presenting,
	}, nil
}

func defaultScreenAnnotation(environment string) bool {
	switch environment {
	case DefaultEnvironment, "dev", "development", "nightly", "staging":
		return true
	default:
		return false
	}
}
