package recordingpipeline

var stateTransitions = map[State]map[State]bool{
	StateRequested: {
		StateReserved: true,
	},
	StateReserved: {
		StateCaptureLeased:    true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
		StateDeleted:          true,
	},
	StateCaptureLeased: {
		StateCapturingSegmented: true,
		StateRetryableFailure:   true,
		StateTerminalFailure:    true,
	},
	StateCapturingSegmented: {
		StateCaptureComplete:  true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
	},
	StateCaptureComplete: {
		StateRenderQueued:     true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
	},
	StateRenderQueued: {
		StateRendering:        true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
	},
	StateRendering: {
		StateVerifying:        true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
	},
	StateVerifying: {
		StateCommitted:        true,
		StateRetryableFailure: true,
		StateTerminalFailure:  true,
	},
	StateCommitted: {
		StateDeleted: true,
	},
	StateRetryableFailure: {
		StateCaptureLeased:   true,
		StateRenderQueued:    true,
		StateTerminalFailure: true,
		StateDeleted:         true,
	},
	StateTerminalFailure: {
		StateDeleted: true,
	},
}

type CapturePlacement struct {
	EpisodesPerNode     int
	ParticipantsPerNode int
	InputMbpsPerNode    int
	ReadySpare          int
}
