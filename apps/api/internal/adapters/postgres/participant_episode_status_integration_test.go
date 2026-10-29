package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func TestEndingEpisodeFailsActiveAuthorizationButRetainsLifecycleRead(t *testing.T) {
	ctx, pool := chatAttachmentQuotaPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	own := chatAttachmentQuotaFixture(ctx, t, tx)(true)
	foreign := chatAttachmentQuotaFixture(ctx, t, tx)(true)
	fixture := newRouteMatrixFixture(t, tx, own, foreign)
	// The refresh endpoint maps this same false authorization result to access.forbidden.
	mustExec(t, tx, `update episodes set status='ending' where tenant_id=$1 and space_id=$2 and id=$3`, uuid(own.TenantID), uuid(own.SpaceID), uuid(own.EpisodeID))
	subject := accessgrants.Subject{TenantID: own.TenantID, SpaceID: own.SpaceID, EpisodeID: own.EpisodeID, ParticipantID: own.ParticipantID, ParticipantGeneration: 1, Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: "matrix-own-connection"}
	allowed, err := fixture.options.ParticipantMediaActive.AuthorizeActiveParticipant(ctx, subject)
	if err != nil || allowed {
		t.Fatalf("ending Episode active authorization: allowed=%t, err=%v", allowed, err)
	}
	path := "/v1/tenants/" + own.TenantID.String() + "/spaces/" + own.SpaceID.String() + "/episodes/" + own.EpisodeID.String() + "/participants/" + own.ParticipantID.String() + "/episode-status"
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+fixture.mediaToken)
	response := httptest.NewRecorder()
	httpapi.NewRouter(fixture.options).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("lifecycle read: %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "ending" {
		t.Fatalf("lifecycle status=%q, want ending", body.Status)
	}
}
