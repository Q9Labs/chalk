package postgres

import (
	"encoding/base64"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func mapCapturePlanFacts(values []completionCapturePlanWire, captureEpoch int64) ([]recordingpresentation.CapturePlanFact, error) {
	var result []recordingpresentation.CapturePlanFact
	for _, value := range values {
		planBytes, decodeErr := base64.StdEncoding.Strict().DecodeString(value.PlanBytes)
		if decodeErr != nil {
			return nil, completionSourceError("capture plan", decodeErr)
		}
		plan, decodeErr := captureplan.Decode(planBytes, value.PlanFingerprint)
		if decodeErr != nil {
			return nil, completionSourceError("capture plan", decodeErr)
		}
		authority := plan.Authority()
		if int64(authority.CaptureEpoch) != value.CaptureEpoch || int64(plan.Revision()) != value.SourceRevision || value.CaptureEpoch > captureEpoch {
			return nil, recordingpresentation.ErrInvalidCompletionSource
		}
		result = append(result, recordingpresentation.CapturePlanFact{Revision: value.Revision, Plan: plan, CreatedAt: value.CreatedAt})
	}
	return result, nil
}
