package ops

import "fmt"

type AutoOpenDedupeDecision string

const (
	AutoOpenDedupeDecisionCreateIncident   AutoOpenDedupeDecision = "create_incident"
	AutoOpenDedupeDecisionAppendToIncident AutoOpenDedupeDecision = "append_to_existing_incident"
)

// DecideAutoOpenDedupe applies the spec dedupe rules for critical auto-open signals:
// - no existing incident => create
// - existing open/monitoring incident => append event
// - existing resolved incident => create new incident
func DecideAutoOpenDedupe(existingState *IncidentState) (AutoOpenDedupeDecision, error) {
	if existingState == nil {
		return AutoOpenDedupeDecisionCreateIncident, nil
	}
	if !existingState.IsValid() {
		return "", fmt.Errorf("%w: state=%q", ErrInvalidAutoOpenDedupeRequest, *existingState)
	}
	if existingState.IsActive() {
		return AutoOpenDedupeDecisionAppendToIncident, nil
	}
	if *existingState == IncidentStateResolved {
		return AutoOpenDedupeDecisionCreateIncident, nil
	}
	return "", fmt.Errorf("%w: state=%q", ErrInvalidAutoOpenDedupeRequest, *existingState)
}
