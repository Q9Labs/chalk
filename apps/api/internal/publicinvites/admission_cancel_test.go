package publicinvites

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCancelPendingAdmissionDiscardsRacingGrant(t *testing.T) {
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	arrival := Arrival{TenantID: id(), SpaceID: id(), ArrivalHandle: id(), State: ArrivalPending}
	binding := AdmissionBinding{EpisodeID: id(), ParticipantID: id(), ParticipantGeneration: 1}
	repository := &cancelRepository{collectionRepository: collectionRepository{arrival: arrival, binding: binding}}
	access := &cancelAccess{started: make(chan struct{}), release: make(chan struct{}), binding: binding}
	runtime := Runtime{service: NewService(repository), access: access}
	type outcome struct {
		result PublicSpaceArrival
		err    error
	}
	completed := make(chan outcome, 1)
	go func() {
		result, _, err := runtime.resolvePendingAdmission(context.Background(), PublicSpace{}, arrival, func() error { return nil })
		completed <- outcome{result, err}
	}()
	<-access.started
	err := runtime.Leave(context.Background(), PublicInviteLeaveInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: "cancel-test-credential"})
	close(access.release)
	result := <-completed
	if err != nil {
		t.Fatalf("cancel pending knock: %v", err)
	}
	if result.err != nil || result.result.State != ArrivalUnavailable || result.result.Access != nil {
		t.Fatalf("cancelled guest collected access: %+v", result)
	}
	if access.discarded != 1 {
		t.Fatalf("discarded grants = %d, want 1", access.discarded)
	}
	if err := runtime.Leave(context.Background(), PublicInviteLeaveInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: "cancel-test-credential"}); err != nil {
		t.Fatalf("repeat cancellation: %v", err)
	}
}

func TestCancelRevokesAdmissionCollectedBeforeWithdrawal(t *testing.T) {
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	arrival := Arrival{TenantID: id(), SpaceID: id(), ArrivalHandle: id(), State: ArrivalPending}
	collected := arrival
	collected.State = ArrivalAdmitted
	collected.EpisodeID, collected.ParticipantID, collected.ParticipantGeneration = id(), id(), 1
	collected.Provider, collected.ProviderSubject = PublicProviderCloudflareSFU, "collected-connection"
	repository := &cancelRepository{collectionRepository: collectionRepository{arrival: arrival}, collected: &collected}
	access := &cancelAccess{}
	runtime := Runtime{service: NewService(repository), access: access}
	if err := runtime.Leave(context.Background(), PublicInviteLeaveInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: "cancel-test-credential"}); err != nil {
		t.Fatal(err)
	}
	if repository.arrival.State != ArrivalLeft || access.revoked != 1 {
		t.Fatalf("collected admission survived Cancel: state=%s revoked=%d", repository.arrival.State, access.revoked)
	}
}

type cancelRepository struct {
	collectionRepository
	collected *Arrival
}

func (r *cancelRepository) UpdateArrivalState(ctx context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	if input.RequirePending && input.State == ArrivalUnavailable && r.collected != nil {
		r.mu.Lock()
		r.arrival = *r.collected
		r.collected = nil
		r.mu.Unlock()
		return Arrival{}, ErrArrivalUnavailable
	}
	return r.collectionRepository.UpdateArrivalState(ctx, input)
}

func (r *cancelRepository) GetArrivalForCredential(ctx context.Context, handle utilities.ID, _ []byte) (Arrival, error) {
	return r.GetArrival(ctx, handle)
}

type cancelAccess struct {
	Access
	started   chan struct{}
	release   chan struct{}
	binding   AdmissionBinding
	discarded int
	revoked   int
}

func (a *cancelAccess) GrantPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	close(a.started)
	<-a.release
	return PublicAccessGrant{TenantID: input.Arrival.TenantID, SpaceID: input.Arrival.SpaceID, EpisodeID: a.binding.EpisodeID, ParticipantID: a.binding.ParticipantID, ParticipantGeneration: a.binding.ParticipantGeneration, Provider: PublicProviderCloudflareSFU, ProviderSubject: "cancelled-connection", ClientPayload: PublicAccessClientPayload{ConnectionID: "cancelled-connection", StunServer: "stun:fixture"}}, nil
}

func (a *cancelAccess) DiscardPublicAccess(context.Context, PublicAccessGrant) error {
	a.discarded++
	return nil
}

func (a *cancelAccess) RevokePublicAccess(context.Context, PublicAccessInput) error {
	a.revoked++
	return nil
}
