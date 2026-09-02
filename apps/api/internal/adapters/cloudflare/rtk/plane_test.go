package rtk_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/rtk"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestResumeJoinRefreshesExistingParticipantToken(t *testing.T) {
	type observedRequest struct{ method, path string }
	requestObserved := make(chan observedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestObserved <- observedRequest{method: request.Method, path: request.URL.Path}
		writer.Header().Set("Content-Type", "application/json")
		if _, writeErr := writer.Write([]byte(`{"data":{"token":"restored-token"}}`)); writeErr != nil {
			t.Errorf("write response: %v", writeErr)
		}
	}))
	t.Cleanup(server.Close)

	plane, err := rtk.NewPlaneWithClient(config.CloudflareRealtimeConfig{
		AccountID: "account-id", APIToken: "api-token", RTKAppID: "app-id", RequestTimeout: time.Second,
	}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	join, err := plane.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{
		Provider:              mediaplane.ProviderCloudflareRTK,
		Episode:               mediaplane.Episode{Provider: mediaplane.ProviderCloudflareRTK, Ref: "provider-episode-id"},
		ExternalParticipantID: "chalk-participant-id",
		ConnectionRef:         "rtk-participant-id",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := <-requestObserved
	if request.method != http.MethodPost || !strings.HasSuffix(request.path, "/participants/rtk-participant-id/token") {
		t.Fatalf("request = %s %s, want participant token refresh", request.method, request.path)
	}
	if join.ParticipantRef != "rtk-participant-id" || join.ClientPayload["token"] != "restored-token" {
		t.Fatalf("join = %#v, want restored token for existing participant", join)
	}
}
