package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestRunRouteChatAttachmentUploadScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteChatAttachmentUploadScenario)
	if err != nil {
		t.Fatalf("%v; body=%s events=%#v", err, result.Body, result.Events)
	}
	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}
	assertEvent(
		t,
		result.Events,
		"authentication",
		"chatattachments.ParticipantVerifier.VerifyChatParticipant",
	)
	assertEvent(t, result.Events, "application", "chatattachments.Service.Initiate")

	encoded, err := json.Marshal(result.Events)
	if err != nil {
		t.Fatal(err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{"trace-sync-participant-token", "https://"} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed private material %q", forbidden)
		}
	}
}
