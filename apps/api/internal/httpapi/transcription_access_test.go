package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptDocumentRejectsUnauthorizedReadersBeforeLookup(t *testing.T) {
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	otherTenantID := documentTestID(t, "33333333-3333-4333-8333-333333333333")
	credentialID := documentTestID(t, "44444444-4444-4444-8444-444444444444")
	for _, test := range []struct {
		name      string
		principal *authentication.Principal
		want      error
	}{
		{name: "Participant credential alone grants no Tenant read", want: apiErrorUnauthenticated},
		{name: "user without Tenant membership", principal: &authentication.Principal{Kind: authentication.PrincipalUser, UserID: credentialID}, want: authorization.ErrForbidden},
		{name: "another Tenant API key", principal: &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: credentialID, TenantID: otherTenantID, Scopes: []authentication.Scope{authentication.ScopeTranscriptionsRead}}, want: authorization.ErrForbidden},
		{name: "API key without Transcript read scope", principal: &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: credentialID, TenantID: tenantID}, want: authorization.ErrForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &unauthorizedTranscriptService{}
			objects := &documentObjectServiceStub{}
			endpoint := transcriptDocumentEndpoint(service, objects, authorization.NewTenantPolicy(nil))
			ctx := accessgrants.WithSubject(context.Background(), accessgrants.Subject{
				TenantID: tenantID, ParticipantID: credentialID, ParticipantGeneration: 1,
			})
			if test.principal != nil {
				ctx = authentication.ContextWithPrincipal(ctx, *test.principal)
			}
			_, err := endpoint.handle(ctx, transcriptDocumentRequest{TenantID: tenantID, TranscriptID: credentialID})
			if !errors.Is(err, test.want) {
				t.Fatalf("read error = %v, want %v", err, test.want)
			}
			if service.calls != 0 || objects.calls != 0 {
				t.Fatalf("unauthorized reader reached storage: lookups=%d objects=%d", service.calls, objects.calls)
			}
		})
	}
}

type unauthorizedTranscriptService struct {
	TranscriptArtifactService
	calls int
}

func (service *unauthorizedTranscriptService) Get(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error) {
	service.calls++
	return transcripts.Transcript{}, errors.New("unauthorized lookup must not run")
}
