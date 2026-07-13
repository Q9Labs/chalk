package recordingpipeline

import "time"

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

func CanTransition(from, to State) bool {
	if from == to {
		return true
	}
	return stateTransitions[from][to]
}

func ValidateTransition(from, to State) error {
	if !CanTransition(from, to) {
		return ErrInvalidStateTransition
	}
	return nil
}

type CapturePlacement struct {
	MeetingsPerNode     int
	ParticipantsPerNode int
	InputMbpsPerNode    int
	ReadySpare          int
}

func DesiredCaptureNodes(meetings, participants int, inputBitrateBPS int64, placement CapturePlacement) int {
	if meetings <= 0 && participants <= 0 && inputBitrateBPS <= 0 {
		return 0
	}
	if placement.MeetingsPerNode <= 0 || placement.ParticipantsPerNode <= 0 || placement.InputMbpsPerNode <= 0 {
		return 0
	}
	meetingNodes := ceilDiv(meetings, placement.MeetingsPerNode)
	participantNodes := ceilDiv(participants, placement.ParticipantsPerNode)
	bitrateMbps := int((inputBitrateBPS + 999_999) / 1_000_000)
	bitrateNodes := ceilDiv(bitrateMbps, placement.InputMbpsPerNode)
	nodes := meetingNodes
	if participantNodes > nodes {
		nodes = participantNodes
	}
	if bitrateNodes > nodes {
		nodes = bitrateNodes
	}
	return nodes + placement.ReadySpare
}

func CanAdmit(meetings, participants int, inputBitrateBPS int64) bool {
	return meetings >= 0 && meetings <= MaximumMeetings &&
		participants >= 0 && participants <= MaximumParticipants &&
		inputBitrateBPS >= 0 && inputBitrateBPS <= MaximumInputBitrateTotalBPS
}

// RetryAvailableAt keeps retry timing durable and lets dispatchers add bounded
// jitter before passing the timestamp to PostgreSQL. The executor never needs
// to hold a database connection while waiting.
func RetryAvailableAt(now time.Time, attempt int, base, maximum, jitter time.Duration) time.Time {
	if attempt < 1 {
		attempt = 1
	}
	if base <= 0 {
		base = time.Second
	}
	delay := base
	for i := 1; i < attempt; i++ {
		if maximum > 0 && delay >= maximum/2 {
			delay = maximum
			break
		}
		delay *= 2
	}
	if maximum > 0 && delay > maximum {
		delay = maximum
	}
	if jitter > 0 {
		delay += jitter
		if maximum > 0 && delay > maximum {
			delay = maximum
		}
	}
	return now.Add(delay)
}

func ceilDiv(value, divisor int) int {
	if value <= 0 {
		return 0
	}
	return (value + divisor - 1) / divisor
}
