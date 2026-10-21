package publicinvites

import (
	"context"
	"crypto/ed25519"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

type retrySpace struct {
	Space
	value PublicSpace
}

func (s retrySpace) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (PublicSpace, error) {
	return s.value, nil
}

type retryReplayRepository struct {
	Repository
	arrival Arrival
	invite  Invite
}

func (r *retryReplayRepository) GetInviteByHandle(context.Context, []byte) (Invite, error) {
	return r.invite, nil
}
func (r *retryReplayRepository) GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (Arrival, error) {
	if r.arrival.ArrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	return r.arrival, nil
}
func (r *retryReplayRepository) CreateArrival(_ context.Context, arrival Arrival) (Arrival, error) {
	r.arrival = arrival
	return arrival, nil
}
func (r *retryReplayRepository) CreateAdmissionRequest(context.Context, AdmissionRequest) (AdmissionRequest, error) {
	// The real CreateAdmissionRequest rejects a non-pending arrival via publicAdmissionProvenanceValid.
	return AdmissionRequest{}, ErrArrivalUnavailable
}
func (r *retryReplayRepository) UpdateArrivalState(_ context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	r.arrival.State = input.State
	return r.arrival, nil
}
func TestKnockRetryPreservesAnAlreadyAdmittedArrival(t *testing.T) {
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	signer, err := NewSigner(Keyring{CurrentKeyID: "review-test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"review-test": private.Public().(ed25519.PublicKey)}})
	if err != nil {
		t.Fatal(err)
	}
	invite := Invite{TenantID: id(), SpaceID: id(), Handle: make([]byte, HandleBytes), Generation: 1, StateEpoch: 1, Enabled: true, PublicRole: PublicRoleCollaborator, AdmissionMode: AdmissionOpen}
	repository := &retryReplayRepository{invite: invite}
	service := NewService(repository, signer)
	credential := []byte("0123456789abcdef")
	key := id().String()
	_, err = service.CreateArrival(context.Background(), CreateArrivalInput{TenantID: invite.TenantID, SpaceID: invite.SpaceID, Invite: Token{Handle: invite.Handle, Generation: 1}, InviteStateEpoch: 1, IdentityMode: IdentityGuest, DisplayName: "Joined while open", GuestCredential: credential, IdempotencyKey: key})
	if err != nil {
		t.Fatal(err)
	}
	repository.arrival.State = ArrivalAdmitted
	token, err := service.IssueInviteToken(invite)
	if err != nil {
		t.Fatal(err)
	}
	runtime := Runtime{service: service, space: retrySpace{value: PublicSpace{TenantID: invite.TenantID, SpaceID: invite.SpaceID, AdmissionMode: AdmissionKnock}}}
	result, err := runtime.Arrive(context.Background(), PublicInviteArrivalInput{Token: token, DisplayName: "Joined while open", RequestKey: key, GuestCredential: string(credential)})
	if repository.arrival.State != ArrivalAdmitted || result.State != ArrivalAdmitted || result.Access != nil || err != nil {
		t.Fatalf("retry revoked an existing admission: stored=%s returned=%s err=%v", repository.arrival.State, result.State, err)
	}
}
