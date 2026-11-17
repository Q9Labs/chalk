package episodes

import (
	"errors"
	"testing"
)

func TestEndRequestsCarryTheirReason(t *testing.T) {
	tenant, space, episode := newTestID(t), newTestID(t), newTestID(t)
	tests := []struct {
		reason  EndReason
		payload string
	}{
		{"", `{}`},
		{EndReasonTenantRecovery, `{}`},
		{EndReasonLingerExpired, `{"reason":"linger_expired"}`},
		{EndReasonMaximumDuration, `{"reason":"maximum_duration"}`},
	}
	for _, test := range tests {
		input := RequestEpisodeEndInput{TenantID: tenant, SpaceID: space, EpisodeID: episode, Reason: test.reason, Request: Request{Key: "end-request-key-0001"}}
		if err := prepareEpisodeEndInput(&input); err != nil {
			t.Fatalf("reason %q: %v", test.reason, err)
		}
		if string(input.Request.Payload()) != test.payload {
			t.Errorf("reason %q payload = %s, want %s", test.reason, input.Request.Payload(), test.payload)
		}
	}
}

func TestEndRequestRejectsAnUnknownReason(t *testing.T) {
	input := RequestEpisodeEndInput{TenantID: newTestID(t), SpaceID: newTestID(t), EpisodeID: newTestID(t), Reason: "bored", Request: Request{Key: "end-request-key-0001"}}
	if err := prepareEpisodeEndInput(&input); !errors.Is(err, ErrInvalidIntentPayload) {
		t.Fatalf("unknown reason error = %v", err)
	}
}

func TestEachReasonIsAnotherOperation(t *testing.T) {
	tenant, space, episode := newTestID(t), newTestID(t), newTestID(t)
	fingerprint := func(reason EndReason) [32]byte {
		input := RequestEpisodeEndInput{TenantID: tenant, SpaceID: space, EpisodeID: episode, Reason: reason, Request: Request{Key: "end-request-key-0001"}}
		if err := prepareEpisodeEndInput(&input); err != nil {
			t.Fatal(err)
		}
		return input.Request.Fingerprint
	}
	if fingerprint(EndReasonLingerExpired) == fingerprint(EndReasonTenantRecovery) {
		t.Fatal("a linger end and a host end share a fingerprint")
	}
}
