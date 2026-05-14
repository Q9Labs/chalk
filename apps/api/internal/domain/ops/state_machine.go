package ops

import "fmt"

type StateTransitionResult struct {
	From    IncidentState
	To      IncidentState
	Changed bool
	NoOp    bool
}

var allowedIncidentTransitions = map[IncidentState]map[IncidentState]struct{}{
	IncidentStateOpen: {
		IncidentStateMonitoring: {},
		IncidentStateResolved:   {},
	},
	IncidentStateMonitoring: {
		IncidentStateOpen:     {},
		IncidentStateResolved: {},
	},
	IncidentStateResolved: {},
}

// TransitionIncidentState applies the incident-state machine rules:
// - valid same-state transition is a no-op success
// - resolved incidents are terminal
// - unresolved recurrence should create a new incident, not reopen-in-place
func TransitionIncidentState(from, to IncidentState) (StateTransitionResult, error) {
	if !from.IsValid() {
		return StateTransitionResult{}, fmt.Errorf("%w: from=%q", ErrInvalidIncidentState, from)
	}
	if !to.IsValid() {
		return StateTransitionResult{}, fmt.Errorf("%w: to=%q", ErrInvalidIncidentState, to)
	}
	if from == to {
		return StateTransitionResult{
			From:    from,
			To:      to,
			Changed: false,
			NoOp:    true,
		}, nil
	}
	if _, ok := allowedIncidentTransitions[from][to]; !ok {
		return StateTransitionResult{}, fmt.Errorf("%w: %s -> %s", ErrInvalidIncidentTransition, from, to)
	}
	return StateTransitionResult{
		From:    from,
		To:      to,
		Changed: true,
		NoOp:    false,
	}, nil
}

func CanTransitionIncidentState(from, to IncidentState) bool {
	_, err := TransitionIncidentState(from, to)
	return err == nil
}

// ShouldCreateNewIncidentOnRecurrence enforces the spec rule that resolved
// incidents are never reopened in place.
func ShouldCreateNewIncidentOnRecurrence(existingState IncidentState) (bool, error) {
	if !existingState.IsValid() {
		return false, fmt.Errorf("%w: state=%q", ErrInvalidIncidentState, existingState)
	}
	return existingState == IncidentStateResolved, nil
}
