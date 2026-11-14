package publicinvites

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type waitingGuestStore struct {
	Repository
	arrival    Arrival
	admitErr   error
	admissions []UpdateArrivalStateInput
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
	if input.State == ArrivalAdmitted {
		s.admissions = append(s.admissions, input)
		if s.admitErr != nil {
			return Arrival{}, s.admitErr
		}
	}
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
	arrival   Arrival
	grants    int
	grantErr  error
	requested []PublicAccessInput
	discarded int
}

func (a *openedAccess) DiscardPublicAccess(context.Context, PublicAccessGrant) error {
	a.discarded++
	return nil
}

func (a *openedAccess) GrantPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	a.grants++
	a.requested = append(a.requested, input)
	if a.grantErr != nil {
		return PublicAccessGrant{}, a.grantErr
	}
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

func openedSpaceRuntime(admitErr, grantErr error) (Runtime, *waitingGuestStore, *openedAccess, Arrival) {
	arrival := Arrival{
		ArrivalHandle: utilities.IDFromBytes([16]byte{1}), TenantID: utilities.IDFromBytes([16]byte{2}), SpaceID: utilities.IDFromBytes([16]byte{3}),
		State: ArrivalPending, IdentityMode: IdentityGuest, DisplayName: "Guest",
	}
	store := &waitingGuestStore{arrival: arrival, admitErr: admitErr}
	access := &openedAccess{arrival: arrival, grantErr: grantErr}
	space := openedSpace{space: PublicSpace{TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, AdmissionMode: AdmissionOpen}}
	return Runtime{service: NewService(store), space: space, access: access}, store, access, arrival
}

func pollOpenedSpace(runtime Runtime, arrival Arrival) (PublicSpaceArrival, error) {
	return runtime.ArrivalStatus(context.Background(), PublicInviteArrivalStatusInput{
		ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: "guest-credential-for-test", MediaClients: mediaplane.AllClientProviders(),
	}, func() error { return nil })
}

// Admitting a guest on an opened Space runs under the same transactional fence as admitting a knock, so the
// grant and the admission both name the open mode and the pending arrival they must still find.
func TestOpenAdmissionRunsUnderTheTransactionalFence(t *testing.T) {
	runtime, store, access, arrival := openedSpaceRuntime(nil, nil)
	if _, err := pollOpenedSpace(runtime, arrival); err != nil {
		t.Fatal(err)
	}
	if len(access.requested) != 1 || access.requested[0].RequireAdmission != AdmissionOpen {
		t.Fatalf("grant requests = %+v, want one that requires open admission", access.requested)
	}
	if len(store.admissions) != 1 || !store.admissions[0].RequirePending || store.admissions[0].RequireAdmission != AdmissionOpen {
		t.Fatalf("admissions = %+v, want one that requires a pending arrival in open admission", store.admissions)
	}
}

// The owner revokes the invite after the status poll validated the arrival and before it commits the
// admission. The fence rejects the commit, so the guest gets no access and the provisional grant is discarded.
func TestOpenAdmissionRevokedAfterValidationGrantsNoAccess(t *testing.T) {
	for name, tc := range map[string]struct{ admitErr, grantErr error }{
		"fence rejects the join":   {grantErr: ErrArrivalUnavailable},
		"fence rejects the commit": {admitErr: ErrArrivalUnavailable},
	} {
		t.Run(name, func(t *testing.T) {
			runtime, store, access, arrival := openedSpaceRuntime(tc.admitErr, tc.grantErr)
			result, err := pollOpenedSpace(runtime, arrival)
			if err != nil || result.State != ArrivalUnavailable || result.Access != nil {
				t.Fatalf("status = %+v, %v; want unavailable with no access", result, err)
			}
			if store.arrival.State != ArrivalUnavailable {
				t.Fatalf("stored arrival state = %s, want unavailable", store.arrival.State)
			}
			if wantDiscards := map[bool]int{true: 1, false: 0}[tc.admitErr != nil]; access.discarded != wantDiscards {
				t.Fatalf("discarded grants = %d, want %d", access.discarded, wantDiscards)
			}
		})
	}
}

// A failure that is not a revocation reaches the caller and still discards the provisional grant.
func TestOpenAdmissionStoreFailureDiscardsTheGrant(t *testing.T) {
	boom := errors.New("store down")
	runtime, _, access, arrival := openedSpaceRuntime(boom, nil)
	if result, err := pollOpenedSpace(runtime, arrival); !errors.Is(err, boom) || result.Access != nil {
		t.Fatalf("status = %+v, %v; want the store error and no access", result, err)
	}
	if access.discarded != 1 {
		t.Fatalf("discarded grants = %d, want 1", access.discarded)
	}
}
