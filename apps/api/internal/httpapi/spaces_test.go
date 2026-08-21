package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCreateSpaceRequestPreservesMediaPlanePresence(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		set       bool
		wantValue string
	}{
		{name: "omitted", body: `{}`, set: false},
		{name: "null", body: `{"media_plane":null}`, set: true},
		{name: "empty", body: `{"media_plane":""}`, set: true},
		{name: "valid", body: `{"media_plane":"cf_rtk"}`, set: true, wantValue: "cf_rtk"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var request createSpaceRequest
			if err := json.Unmarshal([]byte(test.body), &request); err != nil {
				t.Fatalf("decode request: %v", err)
			}

			input := request.toCreateInput(utilities.ID{}, utilities.ID{}, "request-key-0000001")
			if input.MediaPlaneSet != test.set {
				t.Fatalf("media plane set = %t, want %t", input.MediaPlaneSet, test.set)
			}
			if input.MediaPlane != test.wantValue {
				t.Fatalf("media plane = %q, want %q", input.MediaPlane, test.wantValue)
			}
		})
	}
}
