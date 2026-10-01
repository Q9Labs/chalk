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
