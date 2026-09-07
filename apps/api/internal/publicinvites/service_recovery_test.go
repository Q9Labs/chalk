package publicinvites

import (
	"context"
	"errors"
	"testing"
)

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
