package mediaplane

import (
	"errors"
	"testing"
)

func TestSimulcastPolicyValidation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		policy  *Simulcast
		invalid bool
	}{
		{"absent", nil, false},
		{"full with fallback", &Simulcast{"h", "none", "asciibetical"}, false},
		{"low adaptive", &Simulcast{"l", "asciibetical", "none"}, false},
		{"trimmed", &Simulcast{" h ", " none ", " asciibetical "}, false},
		{"empty", &Simulcast{}, true},
		{"blank RID", &Simulcast{" ", "none", "asciibetical"}, true},
		{"missing priority", &Simulcast{"h", "", "asciibetical"}, true},
		{"unsupported priority", &Simulcast{"h", "descending", "asciibetical"}, true},
		{"missing fallback", &Simulcast{"h", "none", ""}, true},
		{"unsupported fallback", &Simulcast{"h", "none", "automatic"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireSimulcastPolicy(tc.policy)
			if errors.Is(err, ErrInvalidSignalRequest) != tc.invalid {
				t.Fatalf("invalid=%v: %v", tc.invalid, err)
			}
			if err == nil && tc.policy != nil && tc.policy.PreferredRID != "h" && tc.policy.PreferredRID != "l" {
				t.Fatal("RID was not trimmed")
			}
		})
	}
}

func TestLocalPublicationRejectsSubscriberPolicy(t *testing.T) {
	err := requireTracksRequest(&TracksRequest{ConnectionID: "publisher", Tracks: []Track{{Location: "local", Mid: "0", TrackName: "camera", Source: "camera", Simulcast: &Simulcast{"h", "none", "asciibetical"}}}})
	if !errors.Is(err, ErrInvalidSignalRequest) {
		t.Fatalf("local policy accepted: %v", err)
	}
}

func TestUpdateTracksRequiresAnExistingRemoteSubscriptionWithPolicy(t *testing.T) {
	policy := &Simulcast{"l", "none", "asciibetical"}
	valid := Track{Location: "remote", Mid: "3", TrackName: "camera", SessionID: "publisher", Simulcast: policy}
	for _, tc := range []struct {
		name    string
		request UpdateTracksRequest
		invalid bool
	}{
		{"remote layer switch", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{valid}}, false},
		{"no tracks", UpdateTracksRequest{ConnectionID: "viewer"}, true},
		{"no connection", UpdateTracksRequest{Tracks: []Track{valid}}, true},
		{"local publication", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{{Location: "local", Mid: "3", TrackName: "camera", Simulcast: policy}}}, true},
		{"missing mid", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{{Location: "remote", TrackName: "camera", SessionID: "publisher", Simulcast: policy}}}, true},
		{"missing publisher session", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{{Location: "remote", Mid: "3", TrackName: "camera", Simulcast: policy}}}, true},
		{"missing policy", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{{Location: "remote", Mid: "3", TrackName: "camera", SessionID: "publisher"}}}, true},
		{"invalid policy", UpdateTracksRequest{ConnectionID: "viewer", Tracks: []Track{{Location: "remote", Mid: "3", TrackName: "camera", SessionID: "publisher", Simulcast: &Simulcast{"l", "descending", "none"}}}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := requireUpdateTracksRequest(&tc.request); errors.Is(err, ErrInvalidSignalRequest) != tc.invalid {
				t.Fatalf("invalid=%v: %v", tc.invalid, err)
			}
		})
	}
}
