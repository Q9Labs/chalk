package artifactpolicy

import "errors"

var (
	ErrInvalidRecordingMode     = errors.New("invalid Recording policy mode")
	ErrInvalidTranscriptionMode = errors.New("invalid Transcription policy mode")
)

type RecordingMode string

const (
	RecordingDisabled  RecordingMode = "disabled"
	RecordingManual    RecordingMode = "manual"
	RecordingAutomatic RecordingMode = "automatic"
)

func (mode RecordingMode) Validate() error {
	switch mode {
	case RecordingDisabled, RecordingManual, RecordingAutomatic:
		return nil
	default:
		return ErrInvalidRecordingMode
	}
}

type TranscriptionMode string

const (
	TranscriptionDisabled  TranscriptionMode = "disabled"
	TranscriptionOnDemand  TranscriptionMode = "on_demand"
	TranscriptionAutomatic TranscriptionMode = "automatic"
)

func (mode TranscriptionMode) Validate() error {
	switch mode {
	case TranscriptionDisabled, TranscriptionOnDemand, TranscriptionAutomatic:
		return nil
	default:
		return ErrInvalidTranscriptionMode
	}
}

func (mode TranscriptionMode) rank() int {
	switch mode {
	case TranscriptionDisabled:
		return 0
	case TranscriptionOnDemand:
		return 1
	case TranscriptionAutomatic:
		return 2
	default:
		return -1
	}
}

func transcriptionModeWithinCeiling(mode, ceiling TranscriptionMode) TranscriptionMode {
	if mode.rank() <= ceiling.rank() {
		return mode
	}
	return ceiling
}
