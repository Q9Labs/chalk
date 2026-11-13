package publicinvites

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type waitingGuestStore struct {
	Repository
	arrival Arrival
}

func (s *waitingGuestStore) GetArrival(context.Context, utilities.ID) (Arrival, error) {
	return s.arrival, nil
}

func (s *waitingGuestStore) GetArrivalForCredential(context.Context, utilities.ID, []byte) (Arrival, error) {
	return s.arrival, nil
}

func (s *waitingGuestStore) GetAdmissionRequestForArrival(context.Context, Arrival) (AdmissionRequest, error) {
	return AdmissionRequest{}, ErrAdmissionRequestNotFound
}

func (s *waitingGuestStore) UpdateArrivalState(_ context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	s.arrival.State = input.State
	s.arrival.EpisodeID, s.arrival.ParticipantID = input.EpisodeID, input.ParticipantID
	return s.arrival, nil
}

type openedSpace struct {
	Space
	space PublicSpace
}

func (s openedSpace) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (PublicSpace, error) {
	return s.space, nil
}

type openedAccess struct {
	Access
	arrival Arrival
	grants  int
}

func (a *openedAccess) GrantPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error) {
	a.grants++
	return PublicAccessGrant{
		TenantID: a.arrival.TenantID, SpaceID: a.arrival.SpaceID,
		EpisodeID: utilities.IDFromBytes([16]byte{4}), ParticipantID: utilities.IDFromBytes([16]byte{5}), ParticipantGeneration: 1,
		Provider: PublicProviderCloudflareSFU, ProviderSubject: "subject",
		ClientPayload: PublicAccessClientPayload{ConnectionID: "connection", StunServer: "stun:test"},
	}, nil
}

// A guest who knocked is not turned away when the host changes the Space to open: the next status
// poll admits them (PublicInviteAccess rule OpenedRoomTurnsNoOneAway).
func TestStatusAdmitsWaitingGuestWhenHostOpensSpace(t *testing.T) {
	arrival := Arrival{
		ArrivalHandle: utilities.IDFromBytes([16]byte{1}), TenantID: utilities.IDFromBytes([16]byte{2}), SpaceID: utilities.IDFromBytes([16]byte{3}),
		State: ArrivalPending, IdentityMode: IdentityGuest, DisplayName: "Guest",
	}
	store := &waitingGuestStore{arrival: arrival}
	access := &openedAccess{arrival: arrival}
	space := openedSpace{space: PublicSpace{TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, AdmissionMode: AdmissionOpen}}
	runtime := Runtime{service: NewService(store), space: space, access: access}

	result, err := runtime.ArrivalStatus(context.Background(), PublicInviteArrivalStatusInput{
		ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: "guest-credential-for-test", MediaClients: mediaplane.AllClientProviders(),
	}, func() error { return nil })
	if err != nil || result.State != ArrivalAdmitted || result.Access == nil || access.grants != 1 {
		t.Fatalf("status = %+v, %v, grants = %d; want admitted with access", result, err, access.grants)
	}
}
