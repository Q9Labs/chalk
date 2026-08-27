package httpapi

import "testing"

func TestRecordingRouteContractsHaveNoPublicMaterializationPath(t *testing.T) {
	want := map[string]struct{}{
		"listRecordings":             {},
		"getRecording":               {},
		"createRecordingDownloadURL": {},
	}

	for _, endpoint := range recordingEndpoints(nil, nil, nil) {
		operationID := endpoint.RouteContract().OperationID
		if _, ok := want[operationID]; !ok {
			t.Fatalf("unexpected public Recording operation %q", operationID)
		}
		delete(want, operationID)
	}
	for operationID := range want {
		t.Fatalf("missing public Recording operation %q", operationID)
	}
}

func TestPublicContractHasNoRecordingPipelineOperations(t *testing.T) {
	banned := map[string]struct{}{
		"createRecording":             {},
		"updateRecording":             {},
		"createRecordingReservation":  {},
		"getRecordingReservation":     {},
		"extendRecordingReservation":  {},
		"releaseRecordingReservation": {},
		"getRecordingPipeline":        {},
	}
	for _, contract := range PreviewRouteContracts() {
		if _, ok := banned[contract.OperationID]; ok {
			t.Fatalf("public contract still exposes %q", contract.OperationID)
		}
	}
}
