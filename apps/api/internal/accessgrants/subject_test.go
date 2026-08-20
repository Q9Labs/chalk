package accessgrants_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

func TestSubjectContextUsesDedicatedTypedValue(t *testing.T) {
	subject := testSubject(t)
	ctx := accessgrants.WithSubject(context.Background(), subject)
	got, ok := accessgrants.SubjectFromContext(ctx)
	if !ok || got != subject {
		t.Fatalf("subject = %#v, present = %v", got, ok)
	}
	if _, ok := accessgrants.SubjectFromContext(context.Background()); ok {
		t.Fatal("empty context unexpectedly contained a subject")
	}
}

func TestRequireRouteSubjectRequiresExactBinding(t *testing.T) {
	subject := testSubject(t)
	route := accessgrants.RouteSubject(subject)
	if err := accessgrants.RequireRouteSubject(subject, route); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		change func(*accessgrants.RouteSubject)
	}{
		{name: "tenant", change: func(route *accessgrants.RouteSubject) {
			route.TenantID = mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
		}},
		{name: "space", change: func(route *accessgrants.RouteSubject) {
			route.SpaceID = mustID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		}},
		{name: "episode", change: func(route *accessgrants.RouteSubject) {
			route.EpisodeID = mustID(t, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
		}},
		{name: "participant", change: func(route *accessgrants.RouteSubject) {
			route.ParticipantID = mustID(t, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
		}},
		{name: "generation", change: func(route *accessgrants.RouteSubject) { route.ParticipantGeneration++ }},
		{name: "provider", change: func(route *accessgrants.RouteSubject) { route.Provider = "other_sfu" }},
		{name: "connection", change: func(route *accessgrants.RouteSubject) { route.CloudflareConnectionID = "connection_other" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mismatch := route
			test.change(&mismatch)
			if err := accessgrants.RequireRouteSubject(subject, mismatch); !errors.Is(err, accessgrants.ErrSubjectMismatch) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestRealtimeKitCredentialUsesProviderParticipantReference(t *testing.T) {
	fixture := newCredentialFixture(t)
	subject := testSubject(t)
	subject.Provider = accessgrants.ProviderCloudflareRTK
	subject.CloudflareConnectionID = ""
	subject.ProviderSubject = "rtk-participant-123"

	credential, err := fixture.issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	got, err := fixture.verifier.Verify(context.Background(), credential.Token)
	if err != nil {
		t.Fatal(err)
	}
	if got != subject {
		t.Fatalf("subject = %#v, want %#v", got, subject)
	}

	if err := accessgrants.RequireRouteSubject(got, accessgrants.RouteSubject{
		TenantID: got.TenantID, SpaceID: got.SpaceID, EpisodeID: got.EpisodeID,
		ParticipantID: got.ParticipantID, ParticipantGeneration: got.ParticipantGeneration,
		Provider: accessgrants.ProviderCloudflareRTK, ProviderSubject: "rtk-participant-123",
	}); err != nil {
		t.Fatalf("matching provider subject rejected: %v", err)
	}
	if err := accessgrants.RequireRouteSubject(got, accessgrants.RouteSubject{
		TenantID: got.TenantID, SpaceID: got.SpaceID, EpisodeID: got.EpisodeID,
		ParticipantID: got.ParticipantID, ParticipantGeneration: got.ParticipantGeneration,
		Provider: accessgrants.ProviderCloudflareRTK, CloudflareConnectionID: "rtk-participant-123",
	}); !errors.Is(err, accessgrants.ErrSubjectMismatch) {
		t.Fatalf("connection alias accepted for RTK subject: %v", err)
	}
}

func TestRequireRouteSubjectRejectsUnknownProvider(t *testing.T) {
	subject := testSubject(t)
	subject.Provider = "unknown-provider"
	route := accessgrants.RouteSubject{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID,
		ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration,
		Provider: "unknown-provider", CloudflareConnectionID: subject.CloudflareConnectionID,
	}
	if err := accessgrants.RequireRouteSubject(subject, route); !errors.Is(err, accessgrants.ErrSubjectMismatch) {
		t.Fatalf("unknown provider accepted: %v", err)
	}
}

func TestStableErrorsDoNotExposeCredentialOrClaims(t *testing.T) {
	fixture := newCredentialFixture(t)
	token := rewriteClaims(t, fixture.token, fixture.privateKey, func(claims map[string]any) { claims["aud"] = "chalk-sync" })
	_, err := fixture.verifier.Verify(context.Background(), token)
	if !errors.Is(err, accessgrants.ErrInvalidAudience) {
		t.Fatalf("error = %v", err)
	}
	for _, forbidden := range []string{token, fixture.subject.TenantID.String(), fixture.subject.CloudflareConnectionID} {
		if err != nil && forbidden != "" && strings.Contains(err.Error(), forbidden) {
			t.Fatalf("error exposed protected value: %q", err)
		}
	}
}
