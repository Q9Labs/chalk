package publicinvites

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRestoreAdmittedAccessUsesPersistedArrivalBinding(t *testing.T) {
	tenantID, _ := utilities.NewID()
	spaceID, _ := utilities.NewID()
	episodeID, _ := utilities.NewID()
	participantID, _ := utilities.NewID()
	arrival := Arrival{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 3, Provider: PublicProviderCloudflareRTK, ProviderSubject: "provider-participant", State: ArrivalAdmitted}
	access := &discardRecordingAccess{restoreGrant: PublicAccessGrant{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 3,
		Provider: PublicProviderCloudflareRTK, ProviderSubject: "provider-participant",
		ClientPayload: PublicAccessClientPayload{ProviderSubject: "provider-participant", Token: "provider-token"},
	}}

	grant, err := (Runtime{access: access}).restoreAdmittedAccess(context.Background(), arrival)
	if err != nil {
		t.Fatal(err)
	}
	if access.restoreCalls != 1 || grant.ProviderSubject != arrival.ProviderSubject {
		t.Fatalf("restore calls = %d, provider subject = %q; want one restore for %q", access.restoreCalls, grant.ProviderSubject, arrival.ProviderSubject)
	}
}

func TestDiscardSupersededPublicAccessRemovesPreviousProviderBinding(t *testing.T) {
	access := &discardRecordingAccess{}
	runtime := Runtime{access: access}
	arrival := Arrival{Provider: PublicProviderCloudflareRTK, ProviderSubject: "previous-provider-participant"}
	grant := PublicAccessGrant{Provider: PublicProviderCloudflareRTK, ProviderSubject: "replacement-provider-participant"}

	runtime.discardSupersededPublicAccess(context.Background(), arrival, grant)

	if access.discardCalls != 1 {
		t.Fatalf("discard calls = %d, want 1", access.discardCalls)
	}
	if access.discarded.Provider != arrival.Provider || access.discarded.ProviderSubject != arrival.ProviderSubject {
		t.Fatalf("discarded binding = %q/%q, want %q/%q", access.discarded.Provider, access.discarded.ProviderSubject, arrival.Provider, arrival.ProviderSubject)
	}
}

func TestDiscardSupersededPublicAccessKeepsCurrentProviderBinding(t *testing.T) {
	access := &discardRecordingAccess{}
	runtime := Runtime{access: access}
	arrival := Arrival{Provider: PublicProviderCloudflareSFU, ProviderSubject: "provider-participant"}
	grant := PublicAccessGrant{Provider: arrival.Provider, ProviderSubject: arrival.ProviderSubject}

	runtime.discardSupersededPublicAccess(context.Background(), arrival, grant)

	if access.discardCalls != 0 {
		t.Fatalf("discard calls = %d, want 0", access.discardCalls)
	}
}

type discardRecordingAccess struct {
	discardCalls int
	discarded    PublicAccessGrant
	restoreCalls int
	restoreGrant PublicAccessGrant
}

func (*discardRecordingAccess) GrantPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error) {
	return PublicAccessGrant{}, errors.New("unexpected GrantPublicAccess call")
}

func (a *discardRecordingAccess) RestorePublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error) {
	a.restoreCalls++
	return a.restoreGrant, nil
}

func (*discardRecordingAccess) RefreshPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error) {
	return PublicAccessGrant{}, errors.New("unexpected RefreshPublicAccess call")
}

func (*discardRecordingAccess) RevokePublicAccess(context.Context, PublicAccessInput) error {
	return errors.New("unexpected RevokePublicAccess call")
}

func (a *discardRecordingAccess) DiscardPublicAccess(_ context.Context, grant PublicAccessGrant) error {
	a.discardCalls++
	a.discarded = grant
	return nil
}
