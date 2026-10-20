package publicinvites

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestConcurrentAdmissionCollectionKeepsWinningMediaBinding(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(fmt.Sprintf("shared_provider_binding=%t", shared), func(t *testing.T) {
			id := func() utilities.ID {
				value, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				return value
			}
			arrival := Arrival{TenantID: id(), SpaceID: id(), ArrivalHandle: id(), State: ArrivalPending}
			binding := AdmissionBinding{EpisodeID: id(), ParticipantID: id(), ParticipantGeneration: 1}
			repository := &collectionRepository{arrival: arrival, binding: binding}
			access := &collectionAccess{ready: make(chan struct{}), shared: shared, binding: binding}
			runtime := Runtime{service: NewService(repository), access: access}
			type outcome struct {
				result   PublicSpaceArrival
				resolved bool
				err      error
			}
			results := make(chan outcome, 2)
			for range 2 {
				go func() {
					result, resolved, err := runtime.resolvePendingAdmission(context.Background(), PublicSpace{}, arrival)
					results <- outcome{result, resolved, err}
				}()
			}
			grants := 0
			var winner string
			for range 2 {
				result := <-results
				if result.err != nil || !result.resolved || result.result.State != ArrivalAdmitted {
					t.Fatalf("collection = %+v", result)
				}
				if result.result.Access != nil {
					grants++
					winner = result.result.Access.ProviderSubject
				}
			}
			if grants != 1 {
				t.Fatalf("returned %d access grants, want one winner and one resumable admitted result", grants)
			}
			current, _ := repository.GetArrival(context.Background(), arrival.ArrivalHandle)
			if current.ProviderSubject != winner {
				t.Fatalf("stored binding %q differs from returned winner %q", current.ProviderSubject, winner)
			}
			wantDiscard := 1
			if shared {
				wantDiscard = 0
			}
			if len(access.discarded) != wantDiscard {
				t.Fatalf("discarded %v, want %d losing bindings", access.discarded, wantDiscard)
			}
			for _, discarded := range access.discarded {
				if discarded == winner {
					t.Fatal("discarded the winning media binding")
				}
			}
		})
	}
}

type collectionRepository struct {
	Repository
	mu      sync.Mutex
	arrival Arrival
	binding AdmissionBinding
}

func (r *collectionRepository) GetAdmissionRequestForArrival(context.Context, Arrival) (AdmissionRequest, error) {
	return AdmissionRequest{State: AdmissionRequestApproved, Binding: &r.binding}, nil
}
func (r *collectionRepository) GetArrival(context.Context, utilities.ID) (Arrival, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.arrival, nil
}
func (r *collectionRepository) UpdateArrivalState(_ context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if input.RequirePending && r.arrival.State != ArrivalPending {
		return Arrival{}, ErrArrivalUnavailable
	}
	r.arrival.State = input.State
	r.arrival.EpisodeID = input.EpisodeID
	r.arrival.ParticipantID = input.ParticipantID
	r.arrival.ParticipantGeneration = input.ParticipantGeneration
	r.arrival.Provider = input.Provider
	r.arrival.ProviderSubject = input.ProviderSubject
	return r.arrival, nil
}

type collectionAccess struct {
	Access
	mu        sync.Mutex
	ready     chan struct{}
	grants    int
	shared    bool
	binding   AdmissionBinding
	discarded []string
}

func (a *collectionAccess) GrantPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	a.mu.Lock()
	a.grants++
	subject := fmt.Sprintf("connection-%d", a.grants)
	if a.shared {
		subject = "shared-connection"
	}
	if a.grants == 2 {
		close(a.ready)
	}
	a.mu.Unlock()
	<-a.ready
	return PublicAccessGrant{TenantID: input.Arrival.TenantID, SpaceID: input.Arrival.SpaceID, EpisodeID: a.binding.EpisodeID, ParticipantID: a.binding.ParticipantID, ParticipantGeneration: a.binding.ParticipantGeneration, Provider: PublicProviderCloudflareSFU, ProviderSubject: subject, ClientPayload: PublicAccessClientPayload{ConnectionID: subject, StunServer: "stun:test"}}, nil
}
func (a *collectionAccess) DiscardPublicAccess(_ context.Context, grant PublicAccessGrant) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.discarded = append(a.discarded, grant.ProviderSubject)
	return nil
}
