package httpapi

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccessGrantSubjectForJoinUsesProviderSpecificBinding(t *testing.T) {
	request := issueAccessGrantRequest{
		TenantID:      testAccessGrantID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:       testAccessGrantID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:     testAccessGrantID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID: testAccessGrantID(t, "44444444-4444-4444-8444-444444444444"),
		Body:          issueAccessGrantBody{ParticipantGeneration: 7},
	}

	t.Run("sfu connection", func(t *testing.T) {
		subject, err := accessGrantSubjectForJoin(request, mediaplane.Join{
			Provider:       mediaplane.ProviderCloudflareSFU,
			ParticipantRef: request.ParticipantID.String(),
			ClientPayload:  map[string]any{"connectionId": "connection-123"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if subject.Provider != accessgrants.ProviderCloudflareSFU || subject.CloudflareConnectionID != "connection-123" || subject.ProviderSubject != "" {
			t.Fatalf("subject = %#v", subject)
		}
	})

	t.Run("realtimekit participant", func(t *testing.T) {
		subject, err := accessGrantSubjectForJoin(request, mediaplane.Join{
			Provider:       mediaplane.ProviderCloudflareRTK,
			ParticipantRef: "rtk-participant-123",
			ClientPayload:  map[string]any{"token": "provider-token"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if subject.Provider != accessgrants.ProviderCloudflareRTK || subject.ProviderSubject != "rtk-participant-123" || subject.CloudflareConnectionID != "" {
			t.Fatalf("subject = %#v", subject)
		}
	})

	t.Run("unknown provider", func(t *testing.T) {
		_, err := accessGrantSubjectForJoin(request, mediaplane.Join{Provider: "unknown"})
		if !errors.Is(err, mediaplane.ErrInvalidProvider) {
			t.Fatalf("error = %v, want invalid provider", err)
		}
	})
}

func testAccessGrantID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
